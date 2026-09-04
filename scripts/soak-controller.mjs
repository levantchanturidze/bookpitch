#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Durable 24-hour soak controller.
//
// The soak has been "about to start" for three phases and has never once run,
// because every previous attempt depended on a session staying alive for 24
// hours. This one does not: all state lives in a GitHub issue body, every tick
// is a scheduled workflow run, and nothing sleeps. Close the terminal and it
// keeps going; the evidence is public and reconstructable by anyone.
//
// What a soak is FOR. Not "24 hours passed". A soak asserts that a specific
// deployment stayed healthy, unattended, across a window long enough to cover
// the daily jobs — the nightly backup, the retention sweep, a full day of cron
// deliveries. So the terminal rule is:
//
//   SUCCESS = every gate satisfied, over an UNINTERRUPTED window, on ONE SHA.
//
// Time alone can never satisfy it. A release-critical failure does not fail the
// soak, it RESTARTS it: the window resets to the moment of the failure, because
// what has to be uninterrupted is the healthy stretch, not the elapsed clock.
//
// Design notes:
//
//  * evaluateSoak() is pure and is where all the judgement lives. The IO layer
//    below it only fetches and writes. Same split as production-monitor.mjs,
//    and for the same reason: the judgement is the part worth testing.
//  * Only `event === 'schedule'` runs count as evidence. A workflow_dispatch
//    proves an endpoint answers; it proves nothing about unattended operation,
//    which is the entire claim a soak makes. This is the same defect that
//    closed incident #38 on displaced evidence, and it would be far worse here
//    — a soak is exactly the thing someone would be tempted to "help along".
//  * No repository writes. State goes in an issue body, so the controller can
//    never push to main.
// -----------------------------------------------------------------------------

import process from 'node:process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { unhealthyJobsFrom } from './heartbeat-contract.mjs';
import { verifyReceiptIntegrity } from './sentry-receipt.mjs';
import { normaliseRun, isNaturalObservation, isNaturalSuccess } from './run-evidence.mjs';
import { heartbeatSuccessAt } from './heartbeat-contract.mjs';

export const SOAK_DEFAULTS = {
  /** An uninterrupted healthy window shorter than this is not a soak. */
  windowHours: 24,
  /**
   * Natural monitor observations required inside the window.
   *
   * The monitor is scheduled every 30 minutes, so 24 hours would ideally give
   * ~48. Six is the floor that makes "the monitor ran and was happy" a claim
   * rather than a coincidence, and it tolerates GitHub dropping most of the
   * schedule — which, measured on this account, it does (R-08).
   */
  minObservations: 6,
  /** A backup must actually happen inside the window, not merely have happened. */
  minScheduledBackups: 1,
  /** Cron must keep being delivered, unattended, for the whole window. */
  minScheduledCronRuns: 4,
  /**
   * Largest tolerable hole between natural monitor observations.
   *
   * Six observations satisfy a count and can still leave most of a day
   * unwatched, so density alone is not enough.
   *
   * RECALIBRATED 2026-09-04, and the reason matters. This gate used to have no
   * consequence — failing it coloured a tick red and the window carried on.
   * Making it restart the window (SOAK_HEALTH_GATES) turned a number that had
   * never bitten into one that decides whether a soak can finish, and it had
   * never been calibrated against what GitHub actually does.
   *
   * Measured over 183 scheduled runs of the monitor's own 30-minute schedule,
   * across 15.5 days:
   *
   *   p50 0.82h   p90 2.25h   p95 4.13h   p99 5.03h
   *   gaps over 4h: 172.95, 5.21, 5.03, 4.84, 4.79, 4.73, 4.67, 4.62, 4.39,
   *                 4.26, 4.13
   *
   * There is a clean separation in that list: ordinary delivery lag tops out at
   * 5.21h, and then the next value is 172.95h — the seven-day Actions billing
   * suspension, which is an outage, not a lag.
   *
   * At 5h the gate fires on 1.6% of gaps, which is a 38% chance of tripping at
   * least once in any 24-hour window: the soak would have been a lottery
   * against GitHub's scheduler rather than a measurement of production. At 6h
   * it fires only on the outage. 7h and 8h fire on exactly the same one gap, so
   * they buy nothing and only widen the hole an outage could hide in.
   */
  maxObservationGapHours: 6,
  /** Both canonical hosts must resolve to the deployment under soak. */
  requiredAliases: ['bookpitch.ge', 'www.bookpitch.ge'],
};

/**
 * Gates that mean PRODUCTION IS UNHEALTHY RIGHT NOW, or that its health cannot
 * be read. Any one of them failing puts the soak into awaiting-recovery: the
 * window stops accruing and restarts only at the next fully healthy natural
 * monitor observation.
 *
 * The rule this encodes, and it is the only rule: an uninterrupted window is
 * one in which nothing release-critical was ever wrong. Before this existed,
 * only three signals could invalidate a window — failed scheduled monitor,
 * backup and cron runs, plus in-window incidents. Everything else merely made
 * one tick report `running` with a red line in it, and the window carried on.
 * A Sentry outage at hour 23 therefore produced a SOAK SUCCESS at hour 24.
 */
export const SOAK_HEALTH_GATES = Object.freeze([
  'history-continuity',
  'monitor-clean',
  'observation-gap',
  'no-incident-in-window',
  'outbox-clean',
  'cron-outcomes',
  'observability',
]);

/**
 * Gates that are merely NOT YET SATISFIED. Time, counts, and the nightly sweep
 * that has not come round again. These keep the soak `running`; they are not
 * evidence that anything is wrong.
 *
 * Every emitted gate must appear in exactly one of these two lists, which
 * tests/soak-controller.test.ts asserts — otherwise a gate added later would be
 * silently neither, and a new release-critical failure would once again leave
 * the window intact.
 */
export const SOAK_PROGRESS_GATES = Object.freeze([
  'window-elapsed',
  'monitor-observations',
  'scheduled-backup',
  'scheduled-cron',
  'retention-in-window',
]);

/** Marker so the state block is found by content, never by issue title. */
export const SOAK_MARKER = '<!-- bookpitch-soak-state -->';
export const SOAK_LABEL = 'soak';

// -----------------------------------------------------------------------------
// Soak state integrity.
//
// The Sentry receipt was signed. Everything that actually decides the verdict
// was not: `releaseSha`, `deploymentId`, `startedAt`, `effectiveWindowStart`,
// `awaitingRecoverySince`, `restarts` and `lastProcessedMonitorRun` lived in a
// public GitHub issue body as plain JSON.
//
// Optimistic concurrency does not help. It compares the body against what THIS
// tick read, so it catches an edit made during a tick and is blind to one made
// between ticks — which is 29 minutes out of every 30. Backdate
// `effectiveWindowStart` and the next tick reports a full window; delete a
// restart and the interruption never happened; swap `deploymentId` and the
// soak measures something else.
//
// The signature does not mean the state never changes — the controller rewrites
// it every tick. It means only something holding CRON_SECRET can produce a
// valid one, which is exactly the property the receipt already had.
//
// Signing alone does not stop REPLAY: an attacker can restore an older, validly
// signed body, and an older body has an earlier window start, which is more
// elapsed time. So the window is additionally anchored to something GitHub owns
// and the body cannot move — the soak issue's own creation time. A window
// cannot begin before the issue that records it exists.
// -----------------------------------------------------------------------------

/**
 * Fields the state digest covers: everything a gate reads or a verdict depends
 * on. `stateDigest` itself and the purely informational `lastTickAt` are
 * excluded; `sentry` is covered through its own digest, which is included here
 * so the two cannot be mixed and matched between states.
 */
export const SOAK_SIGNED_FIELDS = Object.freeze([
  'awaitingRecoverySince',
  'deploymentId',
  'effectiveWindowStart',
  'lastProcessedMonitorRun',
  'releaseSha',
  'restarts',
  'startedAt',
  'tickSeq',
]);

/** HMAC over a canonical serialisation. Sorted keys, explicit types. */
export function soakStateDigest(secret, state) {
  const canonical = SOAK_SIGNED_FIELDS.map(
    (k) => `${k}=${JSON.stringify(state?.[k] ?? null)}`,
  ).join('\n');
  // The receipt's own digest is bound in, so a valid receipt cannot be moved
  // into a different soak's state and vice versa.
  const receiptDigestValue = state?.sentry?.digest ?? null;
  return createHmac('sha256', String(secret))
    .update(`${canonical}\nsentry.digest=${JSON.stringify(receiptDigestValue)}`)
    .digest('hex');
}

/**
 * Is this persisted state authentic, and is its window anchored to reality?
 *
 * @param {string} secret
 * @param {object} state
 * @param {string|null} issueCreatedAt  the soak issue's creation time, from GitHub
 */
export function verifySoakState(secret, state, issueCreatedAt) {
  if (!state || typeof state !== 'object') return { ok: false, reason: 'no state' };
  if (typeof state.stateDigest !== 'string' || !/^[0-9a-f]{64}$/.test(state.stateDigest)) {
    return {
      ok: false,
      reason: 'the soak state is not signed — it cannot be distinguished from an edited one',
    };
  }
  const expected = Buffer.from(soakStateDigest(secret, state), 'hex');
  const actual = Buffer.from(state.stateDigest, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return {
      ok: false,
      reason: 'the soak state digest does not match its contents — it was edited after signing',
    };
  }
  // The replay anchor. An older validly-signed body would carry an earlier
  // window; this refuses any window that begins before the issue recording it.
  if (issueCreatedAt) {
    const issueAt = Date.parse(issueCreatedAt);
    const windowAt = Date.parse(state.effectiveWindowStart ?? state.startedAt ?? '');
    const startedAt = Date.parse(state.startedAt ?? '');
    if (!Number.isFinite(issueAt) || !Number.isFinite(windowAt) || !Number.isFinite(startedAt)) {
      return { ok: false, reason: 'the soak state carries no usable window timestamps' };
    }
    // One minute of slack: the issue is created immediately after startedAt is
    // captured, and the two clocks are GitHub's and the runner's.
    if (windowAt < issueAt - 60_000 || startedAt < issueAt - 60_000) {
      return {
        ok: false,
        reason:
          `the window begins at ${new Date(windowAt).toISOString()}, before the soak issue ` +
          `recording it was created at ${issueCreatedAt} — a window cannot predate its own record`,
      };
    }
  }
  return { ok: true };
}

/** Serialise state into a fenced block the next run can parse back out. */
export function renderState(state) {
  return `${SOAK_MARKER}\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``;
}

/** Recover state from an issue body. Returns null when there is none. */
export function parseState(body) {
  if (!body || !body.includes(SOAK_MARKER)) return null;
  const match = /```json\n([\s\S]*?)\n```/.exec(body);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Decide where the soak stands.
 *
 * @param {{
 *   state: {releaseSha: string, deploymentId?: string|null, startedAt: string,
 *           effectiveWindowStart?: string, lastProcessedMonitorRun?: number|null,
 *           awaitingRecoverySince?: string|null,
 *           restarts?: Array<{at: string, reason: string}>},
 *   evidence: {
 *     monitorRuns: Array<{runId: number, event: string, conclusion: string, completedAt: string}>,
 *     backupRuns: Array<{runId: number, event: string, conclusion: string, completedAt: string}>,
 *     cronRuns: Array<{runId: number, event: string, conclusion: string, completedAt: string}>,
 *     incidents: Array<{number: number, createdAt: string, state: string}>,
 *     deployment: {sha: string, id: string, state?: string|null,
 *                  environment?: string|null, aliases?: string[]} | null,
 *     sentry: {configured: boolean, ok: boolean, serverEventId: string|null,
 *              browserEventId: string|null, problems?: string[]} | null,
 *     outboxDead: number | null,
 *     retentionSuccessAt?: string | null,
 *     unhealthyJobs?: string[] | null,
 *     historyComplete?: boolean,
 *   },
 *   now?: Date,
 *   opts?: typeof SOAK_DEFAULTS,
 * }} input
 */
export function evaluateSoak({ state, evidence, now = new Date(), opts = SOAK_DEFAULTS }) {
  const restarts = [...(state.restarts ?? [])];

  // THE WINDOW START IS PERSISTED STATE, not something recomputed each tick.
  //
  // The first version derived it every time from `startedAt` plus whatever
  // failures were still visible in the run history. So a restart survived only
  // as long as the run that caused it stayed inside the fetched page: once it
  // aged out, `windowStart` silently reverted to the original start and the
  // soak claimed hours it had never held uninterrupted. That is the single
  // most dangerous shape a soak can have — it manufactures the evidence.
  let windowStart = new Date(state.effectiveWindowStart ?? state.startedAt);

  // Natural evidence is scheduled AND first-attempt. A rerun keeps the
  // `schedule` event, so this used to accept a hand-pressed button as proof of
  // unattended operation — a failed monitor, backup or cron run could be rerun
  // into a success and the window would look clean.
  const scheduled = (runs) => (runs ?? []).filter(isNaturalObservation);
  const after = (runs, from) => runs.filter((r) => new Date(r.completedAt) > from);

  const fail = (status, summary, extra = {}) => ({
    status,
    windowStart: windowStart.toISOString(),
    effectiveWindowStart: windowStart.toISOString(),
    elapsedHours: (now.getTime() - windowStart.getTime()) / 3_600_000,
    restarts,
    restartedThisTick: null,
    awaitingRecoverySince: state.awaitingRecoverySince ?? null,
    gates: [],
    observations: [],
    evidenceIds: { monitorRuns: [], backupRuns: [], cronRuns: [] },
    // Present on every branch so a caller never has to know which one produced
    // the result in order to read a field off it.
    lastProcessedMonitorRun: state.lastProcessedMonitorRun ?? null,
    summary,
    ...extra,
  });

  // --- Fail closed on missing evidence -------------------------------------
  //
  // A null deployment used to skip the identity check entirely, with a comment
  // claiming a gate would read it as "not evidence of health". No gate did.
  // The soak simply stopped checking which code it was measuring.
  // A soak with no deployment PIN was set up wrong, and no amount of waiting
  // fixes that. Checked before anything transient, because it is the one
  // identity problem that is our fault rather than production's.
  if (!state.deploymentId) {
    return fail(
      'blocked',
      'no deployment id was pinned when the soak started, so there is nothing to compare ' +
        'production against. This is a setup error, not a production failure: start a new ' +
        'soak with the GitHub Deployment record id.',
    );
  }

  const d = evidence.deployment;
  // TWO kinds of identity problem, and conflating them was a defect.
  //
  //   superseded  positive evidence that a DIFFERENT release is serving. The
  //               soak is over; start a new one deliberately.
  //   unreadable  the evidence could not be read this tick. That is a network
  //               or API failure, not a statement about which code is live.
  //
  // Every problem used to be `superseded`, so one failed HTTPS request while
  // reading a release header permanently ended the soak with "the deployment
  // under soak is not the one serving production" — an assertion that was not
  // true, about a condition that would have cleared itself in seconds.
  const supersededProblems = [];
  const unreadableProblems = [];

  if (!d) {
    unreadableProblems.push('the deployment record could not be read at all');
  }

  // Every field is REQUIRED. The previous version guarded each comparison on
  // both sides being truthy — `state.deploymentId && d.id && ...` — so a
  // missing pin silently skipped the check it was supposed to enforce. Absent
  // evidence is not agreement.
  if (d) {
    if (!d.id) unreadableProblems.push('the deployment record carries no id');
    else if (String(d.id) !== String(state.deploymentId)) {
      supersededProblems.push(`deployment is ${d.id}, not the pinned ${state.deploymentId}`);
    }

    if (!d.sha) unreadableProblems.push('the deployment record carries no SHA');
    else if (d.sha !== state.releaseSha) {
      supersededProblems.push(
        `production serves ${String(d.sha).slice(0, 7)}, not the soak's ${String(state.releaseSha).slice(0, 7)}`,
      );
    }

    // A deployment whose status is not success is production being unhealthy,
    // not production being a different release. It can recover.
    if (!d.state) unreadableProblems.push('the deployment has no status');
    else if (d.state !== 'success' && d.state !== 'READY') {
      unreadableProblems.push(`deployment state is ${d.state}, not success/READY`);
    }

    if (!d.environment) unreadableProblems.push('the deployment names no environment');
    else if (d.environment.toLowerCase() !== 'production') {
      supersededProblems.push(`environment is ${d.environment}, not Production`);
    }
  }

  // Aliases must be serving THIS release, not merely answering 200.
  //
  // resolveAliases() used to accept any HTTP 200 and ignore the expected SHA
  // entirely, so a healthy response from a completely different deployment
  // satisfied the gate. Each host now reports the release it is actually
  // serving, read after redirects, and must match.
  const aliasResults = d?.aliasReleases ?? null;
  if (aliasResults === null) {
    unreadableProblems.push('canonical alias evidence could not be read');
  } else {
    for (const host of opts.requiredAliases) {
      const seen = aliasResults[host];
      if (!seen) {
        // Silence from a host is a failed read, not a statement about what it
        // serves.
        unreadableProblems.push(`alias ${host} did not report a release`);
      } else if (seen !== state.releaseSha) {
        supersededProblems.push(
          `alias ${host} serves ${String(seen).slice(0, 7)}, not ${String(state.releaseSha).slice(0, 7)}`,
        );
      }
    }
  }

  // Superseded wins over unreadable: if one host demonstrably serves a
  // different release, the soak is over whatever the other host did.
  if (supersededProblems.length > 0) {
    return fail(
      'superseded',
      `the deployment under soak is not the one serving production: ${supersededProblems.join('; ')}. ` +
        'A soak measures one deployment; start a new one against the new SHA deliberately.',
    );
  }

  // Unreadable identity evidence is a health failure, not a verdict about which
  // code is live. No time accrues, the window will restart at the next healthy
  // observation, and the soak survives a thirty-second API outage instead of
  // being permanently closed by one.
  if (unreadableProblems.length > 0) {
    const at = now.toISOString();
    const reason = `deployment identity could not be established: ${unreadableProblems.join('; ')}`;
    const moment = { at, reason };
    return {
      ...fail(
        'awaiting-recovery',
        `${reason}. This is unreadable evidence, not a superseded deployment — the window ` +
          'restarts at the first fully healthy scheduled monitor observation after this moment.',
      ),
      restarts: [...(state.restarts ?? []), moment],
      awaitingRecoverySince: at,
      restartedThisTick: moment,
    };
  }

  // --- Unhealthy intervals invalidate the window -----------------------------
  //
  // The previous version restarted only for failed monitor observations and
  // incidents, and it restarted AT the moment the failure began — then counted
  // the recovery period as healthy time. Two problems:
  //
  //   * a failed scheduled BACKUP or CRON run could sit inside the window while
  //     the gate passed on other successful runs;
  //   * restarting at the failure and immediately accruing time means the hours
  //     during which production was still broken counted toward the 24.
  //
  // So: any release-critical unhealthy event puts the soak into
  // AWAITING-RECOVERY, and the new window begins only at the first subsequent
  // fully healthy natural monitor observation. No healthy observation, no
  // window — elapsed time cannot accrue on hope.
  const criticalMoments = [];

  const addFailures = (runs, label) => {
    for (const r of after(scheduled(runs), windowStart)) {
      if (r.conclusion !== 'success') {
        criticalMoments.push({
          at: r.completedAt,
          reason: `scheduled ${label} run ${r.runId} concluded ${String(r.conclusion).toUpperCase()}`,
        });
      }
    }
  };
  addFailures(evidence.monitorRuns, 'monitor');
  addFailures(evidence.backupRuns, 'backup');
  addFailures(evidence.cronRuns, 'cron');

  // Incidents opened during the window count even if later closed: production
  // was unhealthy for part of a window that claims to be uninterrupted.
  // `closedAt` is retained so recovery can be required after it.
  const incidentsInWindow = (evidence.incidents ?? []).filter(
    (i) => new Date(i.createdAt) > windowStart,
  );
  for (const i of incidentsInWindow) {
    criticalMoments.push({
      at: i.closedAt && new Date(i.closedAt) > new Date(i.createdAt) ? i.closedAt : i.createdAt,
      reason:
        `production incident #${i.number} opened at ${i.createdAt}` +
        (i.closedAt ? ` and closed at ${i.closedAt}` : ' and is still open'),
    });
  }
  const stillOpenIncidents = (evidence.incidents ?? []).filter((i) => i.state === 'open');

  criticalMoments.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  let restartedThisTick = null;
  let awaitingRecoverySince = state.awaitingRecoverySince ?? null;

  if (criticalMoments.length > 0) {
    const last = criticalMoments[criticalMoments.length - 1];
    if (!awaitingRecoverySince || new Date(last.at) > new Date(awaitingRecoverySince)) {
      awaitingRecoverySince = last.at;
      restartedThisTick = last;
      restarts.push(last);
    }
  }

  if (awaitingRecoverySince) {
    // Recovery is a fully successful SCHEDULED monitor observation strictly
    // after the unhealthy moment — and nothing else. A quiet period is not
    // recovery; neither is a manual run.
    const recovery = scheduled(evidence.monitorRuns)
      .filter(
        (r) =>
          r.conclusion === 'success' && new Date(r.completedAt) > new Date(awaitingRecoverySince),
      )
      .sort((a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime())[0];

    if (!recovery) {
      return {
        ...fail(
          'awaiting-recovery',
          `production was unhealthy at ${awaitingRecoverySince} (${
            restarts[restarts.length - 1]?.reason ?? 'unknown'
          }). The window restarts at the first fully healthy scheduled monitor ` +
            'observation after that moment; none has arrived yet, so no time is accruing.',
        ),
        awaitingRecoverySince,
        restartedThisTick,
      };
    }
    // Recovered: the window starts at the healthy observation, not at the
    // failure. The unhealthy stretch is discarded rather than counted.
    windowStart = new Date(recovery.completedAt);
    awaitingRecoverySince = null;
  }

  // --- Gates ----------------------------------------------------------------
  //
  // Recomputed against the FINAL window start. `incidentsInWindow` above is
  // deliberately measured against the pre-recovery window, because that is how
  // the unhealthy moment is found; reusing it for the gate meant the incident
  // that caused a restart was still "in the window" afterwards. Harmless while
  // a failing gate only coloured a tick red — and, once a failing health gate
  // began restarting the window, a soak that could never recover from an
  // incident at all.
  const incidentsInFinalWindow = (evidence.incidents ?? []).filter(
    (i) => new Date(i.createdAt) > windowStart,
  );

  const observations = after(scheduled(evidence.monitorRuns), windowStart);
  const cleanObservations = observations.filter((r) => r.conclusion === 'success');
  const backups = after(scheduled(evidence.backupRuns), windowStart).filter(
    (r) => r.conclusion === 'success',
  );
  const crons = after(scheduled(evidence.cronRuns), windowStart).filter(
    (r) => r.conclusion === 'success',
  );
  const elapsedHours = (now.getTime() - windowStart.getTime()) / 3_600_000;

  // Largest hole between consecutive natural observations, including the tail
  // from the last observation to now. Six observations spread over 24 hours
  // satisfy a count but not continuity.
  const obsTimes = [
    windowStart.getTime(),
    ...observations.map((r) => new Date(r.completedAt).getTime()),
    now.getTime(),
  ].sort((a, b) => a - b);
  let maxGapHours = 0;
  for (let i = 1; i < obsTimes.length; i++) {
    maxGapHours = Math.max(maxGapHours, (obsTimes[i] - obsTimes[i - 1]) / 3_600_000);
  }

  // Continuity: the history fetched must reach back past the window start, or
  // a failure could have aged out unseen and the gates below would be
  // measuring a shorter, cleaner window than actually occurred.
  const oldestFetched = (evidence.monitorRuns ?? [])
    .map((r) => new Date(r.completedAt).getTime())
    .sort((a, b) => a - b)[0];
  const historyCoversWindow =
    evidence.historyComplete === true ||
    (oldestFetched !== undefined && oldestFetched <= windowStart.getTime());

  const gates = [
    {
      id: 'window-elapsed',
      ok: elapsedHours >= opts.windowHours,
      detail: `${elapsedHours.toFixed(1)}h of an uninterrupted ${opts.windowHours}h window`,
    },
    {
      id: 'history-continuity',
      ok: historyCoversWindow,
      detail: historyCoversWindow
        ? 'fetched monitor history reaches back past the window start'
        : 'fetched monitor history does NOT reach the window start — a failure could have ' +
          'aged out unseen, so the window cannot be certified',
    },
    {
      id: 'monitor-observations',
      ok: cleanObservations.length >= opts.minObservations,
      detail:
        `${cleanObservations.length} natural monitor observations (need ${opts.minObservations}); ` +
        'manual dispatches are not counted',
    },
    {
      id: 'monitor-clean',
      ok: observations.length === cleanObservations.length,
      detail: `${observations.length - cleanObservations.length} non-successful observations in the window`,
    },
    {
      id: 'scheduled-backup',
      ok: backups.length >= opts.minScheduledBackups,
      detail: `${backups.length} successful scheduled backup(s) inside the window (need ${opts.minScheduledBackups})`,
    },
    {
      id: 'scheduled-cron',
      ok: crons.length >= opts.minScheduledCronRuns,
      detail:
        `${crons.length} successful SCHEDULED cron run(s) inside the window ` +
        `(need ${opts.minScheduledCronRuns}); manual dispatches excluded`,
    },
    {
      id: 'observation-gap',
      // A window with a 9-hour hole in the middle is not observed, even if the
      // observations either side are clean and numerous enough.
      ok: maxGapHours <= opts.maxObservationGapHours,
      detail:
        observations.length < 2
          ? `too few observations to measure a gap (${observations.length})`
          : `largest gap between natural observations ${maxGapHours.toFixed(1)}h ` +
            `(limit ${opts.maxObservationGapHours}h)`,
    },
    {
      id: 'no-incident-in-window',
      ok: incidentsInFinalWindow.length === 0 && stillOpenIncidents.length === 0,
      detail:
        incidentsInFinalWindow.length === 0 && stillOpenIncidents.length === 0
          ? 'no incident opened during the window, and none open now'
          : [
              incidentsInFinalWindow.length
                ? `opened during window: ${incidentsInFinalWindow.map((i) => `#${i.number}`).join(', ')}`
                : null,
              stillOpenIncidents.length
                ? `currently open: ${stillOpenIncidents.map((i) => `#${i.number}`).join(', ')}`
                : null,
            ]
              .filter(Boolean)
              .join('; '),
    },
    {
      id: 'outbox-clean',
      ok: evidence.outboxDead === 0,
      detail:
        evidence.outboxDead === null || evidence.outboxDead === undefined
          ? 'outbox dead-letter count could not be read — not evidence of health'
          : `${evidence.outboxDead} dead-lettered outbox row(s)`,
    },
    {
      id: 'cron-outcomes',
      // Per-job, not a scalar. A count of "jobs currently failing" cannot see a
      // job that has never run — it has no row to count — and that is exactly
      // the job most worth catching.
      ok: Array.isArray(evidence.unhealthyJobs) && evidence.unhealthyJobs.length === 0,
      detail: !Array.isArray(evidence.unhealthyJobs)
        ? 'per-job cron outcome state could not be read — not evidence of health'
        : evidence.unhealthyJobs.length === 0
          ? 'every required scheduled job has a fresh successful heartbeat'
          : `not healthy: ${evidence.unhealthyJobs.join(', ')}`,
    },
    {
      id: 'retention-in-window',
      // The reason the window is 24 hours and not 2.
      //
      // `cron-outcomes` asks whether retention's last success is inside its
      // freshness limit, and that limit is 30 hours — it runs nightly and
      // GitHub's delivery is unreliable (R-08). 30 hours is LONGER THAN THE
      // WINDOW, so a sweep from 26 hours ago satisfies it for the entire soak,
      // and a full 24 hours could be certified in which the nightly job never
      // ran once. A window that does not contain the daily work is not a soak
      // of a system that does daily work.
      //
      // Compared as an INSTANT against the effective window start, so a restart
      // invalidates evidence from before it rather than inheriting it.
      ...(() => {
        // An absolute instant from the DATABASE, compared directly with the
        // window start. This used to be an age subtracted from the runner's
        // clock, which is two clocks on one comparison.
        const raw = evidence.retentionSuccessAt;
        const parsed = raw ? Date.parse(raw) : NaN;
        if (!Number.isFinite(parsed)) {
          return {
            ok: false,
            detail:
              'retention success timestamp could not be read — absence of evidence is not ' +
              'evidence that the nightly sweep ran',
          };
        }
        const at = new Date(parsed);
        const inWindow = at >= windowStart;
        return {
          ok: inWindow,
          detail: inWindow
            ? `retention last succeeded ${at.toISOString()}, inside the effective window`
            : `retention last succeeded ${at.toISOString()}, which is BEFORE the window ` +
              `began at ${windowStart.toISOString()} — the nightly sweep has not run in ` +
              'this window',
        };
      })(),
    },
    {
      id: 'observability',
      // Receipt is revalidated against Sentry on EVERY tick, not trusted from
      // persisted state. Losing the DSNs, losing API access, or the receipt
      // ageing out all fail this gate — and a failing gate puts the soak into
      // awaiting-recovery, so the window restarts rather than coasting on a
      // verification done a day earlier.
      ok: Boolean(evidence.sentry?.ok),
      detail: !evidence.sentry
        ? 'Sentry evidence could not be read — not evidence of health'
        : !evidence.sentry.configured
          ? 'production has no Sentry DSN configured — uncaught exceptions are discarded, ' +
            'so an unobserved window proves nothing'
          : evidence.sentry.ok
            ? `receipt revalidated: server ${String(evidence.sentry.serverEventId).slice(0, 12)}, ` +
              `browser ${String(evidence.sentry.browserEventId).slice(0, 12)}, ` +
              'at least one frame resolved to original source'
            : `receipt not valid: ${(evidence.sentry.problems ?? ['unknown']).join('; ')}`,
    },
  ];

  const failing = gates.filter((g) => !g.ok);

  // THE RULE, applied here and nowhere else: any HEALTH gate failing means
  // production was unhealthy — or unreadable — at this instant, so this instant
  // is an unhealthy moment and the window stops.
  //
  // Progress gates (time elapsed, observation counts, the nightly sweep that
  // has not come round again) are not failures and must not restart anything,
  // or the window could never complete.
  //
  // Before this, only failed scheduled runs and in-window incidents could
  // invalidate a window. Sentry receipt revalidation, outbox dead letters,
  // unhealthy jobs and unreadable evidence all merely coloured one tick red and
  // left the clock running — so a failure at hour 23 was followed by SOAK
  // SUCCESS at hour 24.
  const failingHealth = failing.filter((g) => SOAK_HEALTH_GATES.includes(g.id));
  if (failingHealth.length > 0) {
    const at = now.toISOString();
    const reason = `release-critical gate(s) failing: ${failingHealth
      .map((g) => `${g.id} (${g.detail})`)
      .join('; ')}`;
    const moment = { at, reason };
    // Recorded in `restarts` like any other unhealthy moment, so the issue
    // shows the whole history rather than only the run-level failures.
    restarts.push(moment);
    return {
      ...fail(
        'awaiting-recovery',
        `production was unhealthy at ${at} — ${reason}. The window restarts at the first ` +
          'fully healthy scheduled monitor observation after that moment; no time is accruing.',
      ),
      restarts,
      awaitingRecoverySince: at,
      restartedThisTick: moment,
      gates,
    };
  }

  return {
    status: failing.length === 0 ? 'success' : restartedThisTick ? 'restarted' : 'running',
    windowStart: windowStart.toISOString(),
    // Persisted verbatim by the caller so the next tick starts from here.
    effectiveWindowStart: windowStart.toISOString(),
    elapsedHours,
    restarts,
    restartedThisTick,
    awaitingRecoverySince: null,
    gates,
    observations: observations.map((r) => ({
      runId: r.runId,
      at: r.completedAt,
      conclusion: r.conclusion,
    })),
    lastProcessedMonitorRun:
      observations.length > 0
        ? observations.reduce((a, b) => (a.runId > b.runId ? a : b)).runId
        : (state.lastProcessedMonitorRun ?? null),
    evidenceIds: {
      monitorRuns: cleanObservations.map((r) => r.runId),
      backupRuns: backups.map((r) => r.runId),
      cronRuns: crons.map((r) => r.runId),
    },
    summary:
      failing.length === 0
        ? 'every gate satisfied over an uninterrupted window'
        : `${failing.length} gate(s) not yet satisfied: ${failing.map((g) => g.id).join(', ')}`,
  };
}

/**
 * The Sentry receipt to persist for the next tick.
 *
 * Pure, and exported, because two fields here MUST NOT change and nothing else
 * was checking that:
 *
 *   nonce       the receipt is worthless without it — verifySentryReceipt()
 *               requires it, and an earlier version simply did not carry it
 *               forward, so the very next tick reported "no verified event ids
 *               and nonce are persisted";
 *   verifiedAt  it is the `notBefore` freshness bound. An earlier version
 *               rewrote it to now() on every successful tick, which made the
 *               events — created once, at probe time — "predate this
 *               verification run" and fail.
 *
 * Either alone made a valid receipt self-destruct on tick two, and under the
 * corrected state machine that puts the whole soak into awaiting-recovery. A
 * soak that cannot survive its own second tick is not a soak.
 *
 * A FAILED revalidation preserves the receipt rather than erasing it: a
 * transient Sentry API outage must invalidate the soak INTERVAL, not destroy
 * the evidence and force the probe to be re-run.
 */
export function nextSentryState(persisted, verdict) {
  return {
    // Immutable identity of the verification run. Every one of these is a
    // signed field; a tick that rewrote any of them would invalidate the
    // receipt it is carrying, or — worse — launder an edited one.
    notBefore: persisted?.notBefore ?? null,
    nonce: persisted?.nonce ?? null,
    verifiedAt: persisted?.verifiedAt ?? null,
    releaseSha: persisted?.releaseSha ?? null,
    environment: persisted?.environment ?? null,
    // Event ids are preserved through a failed revalidation for the same
    // reason: losing them loses the only thing a later tick could re-check.
    serverEventId: verdict?.serverEventId ?? persisted?.serverEventId ?? null,
    browserEventId: verdict?.browserEventId ?? persisted?.browserEventId ?? null,
    // Also immutable identity: the files the stacks resolved to, the
    // affirmative public-map result, and the digest that authenticates all of
    // it. A tick that rewrote any of these could launder a tampered receipt
    // into a clean one on the next pass.
    serverSource: persisted?.serverSource ?? null,
    browserSource: persisted?.browserSource ?? null,
    sourceMapsPublic: persisted?.sourceMapsPublic ?? null,
    digest: persisted?.digest ?? null,
    // The only fields a tick may update: what it observed this time.
    configured: Boolean(verdict?.configured),
    lastRevalidationOk: Boolean(verdict?.ok),
    lastRevalidationAt: new Date().toISOString(),
    lastProblems: verdict?.problems ?? [],
  };
}

/**
 * Turn a receipt produced by scripts/verify-sentry.mjs into persisted soak
 * state. The supported — and only — way evidence gets in.
 *
 * Before this existed, verifySentryReceipt() required `persisted.nonce` and
 * nothing in the system ever wrote one. The observability gate could therefore
 * never pass, and the only way to make it pass would have been to hand-edit the
 * JSON in the soak issue body: an operator typing event ids, which is precisely
 * the ticked-boolean evidence the gate was built to replace. A gate that can
 * only be satisfied by forgery is not a gate.
 *
 * `notBefore` — not `verifiedAt` — becomes the persisted freshness bound. The
 * probe fires first and the receipt is written after, so the events are always
 * a little OLDER than the moment verification finished. Using the finish time
 * would make every receipt reject the very events it had just proved.
 *
 * Throws on anything incomplete. A half-seeded receipt would fail later, in a
 * tick, where it reads as a production problem rather than a setup mistake.
 *
 * @param {string|undefined|null} json  the receipt document, or nothing
 * @returns {{notBefore: string, nonce: string, verifiedAt: string, releaseSha: string,
 *            environment: string, serverEventId: string, browserEventId: string,
 *            serverSource: string, browserSource: string,
 *            sourceMapsPublic: boolean, digest: string,
 *            configured: boolean, lastRevalidationOk: boolean,
 *            lastRevalidationAt: string|null, lastProblems: string[]}|null}
 *   state to persist, or null when no receipt was supplied
 */
export function seedSentryState(json) {
  if (json === undefined || json === null || String(json).trim() === '') return null;

  let r;
  try {
    r = JSON.parse(String(json));
  } catch (err) {
    throw new Error(`Sentry receipt is not valid JSON: ${err.message}`);
  }

  const required = [
    'notBefore',
    'nonce',
    'releaseSha',
    'environment',
    'serverEventId',
    'browserEventId',
    'serverSource',
    'browserSource',
    'digest',
  ];
  const missing = required.filter((k) => !r?.[k] || typeof r[k] !== 'string');
  if (missing.length) {
    throw new Error(`Sentry receipt is incomplete — missing ${missing.join(', ')}`);
  }

  // Integrity, checked at the door. The receipt is about to be written into a
  // public issue body and trusted for 24 hours; an unsigned or edited one must
  // never get that far. CRON_SECRET is the key both the verifier and this
  // controller already hold.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    throw new Error('CRON_SECRET is not set, so the Sentry receipt cannot be authenticated');
  }
  const integrity = verifyReceiptIntegrity(secret, r);
  if (!integrity.ok) {
    throw new Error(`Sentry receipt failed its integrity check: ${integrity.reason}`);
  }
  if (r.serverEventId === r.browserEventId) {
    throw new Error(
      'Sentry receipt names the same event id for both runtimes — one event cannot ' +
        'prove two SDKs',
    );
  }
  if (!Number.isFinite(Date.parse(r.notBefore))) {
    throw new Error('Sentry receipt has an unparseable notBefore');
  }

  return {
    // EVERY signed field is carried through byte-for-byte. Nothing here may be
    // renamed, dropped or recomputed: the digest covers all of them, and the
    // next tick re-authenticates the persisted document against it.
    //
    // This used to drop `notBefore` and overwrite `verifiedAt` with it, keeping
    // the original digest — so the very first revalidation hashed a different
    // document and the observability gate could never pass. A signature scheme
    // whose own seeding step invalidated it.
    //
    // The two timestamps are NOT interchangeable and that is why both are
    // signed: `notBefore` is the freshness bound (the run's start, before any
    // event existed), `verifiedAt` is when verification finished. Use
    // soakFreshnessBound() to read the bound rather than reaching for whichever
    // field looks right.
    notBefore: r.notBefore,
    verifiedAt: r.verifiedAt,
    nonce: r.nonce,
    releaseSha: r.releaseSha,
    environment: r.environment,
    serverEventId: r.serverEventId,
    browserEventId: r.browserEventId,
    // Which repository file each runtime's stack resolved to, and the
    // affirmative public-source-map result. Re-checked on every tick, so a
    // later event that resolves somewhere else fails the gate.
    serverSource: r.serverSource,
    browserSource: r.browserSource,
    sourceMapsPublic: r.sourceMapsPublic,
    // Kept so every tick can re-authenticate the receipt it is trusting,
    // rather than only the tick that seeded it.
    digest: r.digest,
    // Nothing has been revalidated yet; the first tick does that.
    configured: false,
    lastRevalidationOk: false,
    lastRevalidationAt: null,
    lastProblems: [],
  };
}

/**
 * The freshness bound a persisted receipt imposes on its events.
 *
 * `notBefore` — the moment the verification run STARTED, before any probe had
 * fired — and never `verifiedAt`, which is when it finished. The events were
 * created between the two, so a bound at `verifiedAt` rejects the very events
 * the receipt exists to vouch for.
 *
 * A named accessor rather than a field read at each call site, because the two
 * timestamps look interchangeable and are not. Reaching for the wrong one is
 * exactly the mistake that made seeding overwrite a signed field.
 *
 * @param {{notBefore?: string|null}|null|undefined} sentry
 * @returns {Date} epoch 0 when absent, so a missing bound admits nothing
 */
export function soakFreshnessBound(sentry) {
  const raw = sentry?.notBefore;
  const at = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(at) ? new Date(at) : new Date(0);
}

/** The comment posted on every tick. Public, so it must carry no secrets. */
export function renderReport(state, result) {
  const mark = (g) => (g.ok ? '✅' : '⏳');
  const lines = [
    result.status === 'success'
      ? '## SOAK SUCCESS — 24 uninterrupted hours on one deployment\n\n' +
        '> This is the TECHNICAL gate only, and it is the ONLY thing this\n' +
        '> controller can attest to. Releasing additionally requires legal\n' +
        '> approval and designated-mailbox UAT, neither of which is observable\n' +
        '> from here. A green soak is not a green release.'
      : result.status === 'superseded'
        ? '## Soak ended — the deployment it was measuring was replaced'
        : result.status === 'blocked'
          ? '## Soak BLOCKED — evidence could not be read'
          : result.status === 'awaiting-recovery'
            ? '## Soak AWAITING RECOVERY — no time is accruing'
            : result.status === 'restarted'
              ? '## Soak window RESTARTED'
              : '## Soak in progress',
    '',
    `- **Release SHA:** \`${state.releaseSha}\``,
    `- **Deployment:** \`${state.deploymentId}\``,
    `- **Window start:** ${result.windowStart}`,
    `- **Elapsed:** ${(result.elapsedHours ?? 0).toFixed(1)}h`,
    `- **Restarts:** ${result.restarts.length}`,
    '',
  ];
  if (result.restartedThisTick) {
    lines.push(
      `> Window reset to ${result.restartedThisTick.at} — ${result.restartedThisTick.reason}.`,
      '> The 24 hours must be uninterrupted, so the clock starts again from the failure.',
      '',
    );
  }
  if (result.gates.length) {
    lines.push('| | gate | detail |', '| --- | --- | --- |');
    for (const g of result.gates) lines.push(`| ${mark(g)} | \`${g.id}\` | ${g.detail} |`);
    lines.push('');
  }
  if (result.evidenceIds) {
    lines.push(
      '**Evidence**',
      '',
      `- Monitor runs: ${result.evidenceIds.monitorRuns.join(', ') || '(none yet)'}`,
      `- Backup runs: ${result.evidenceIds.backupRuns.join(', ') || '(none yet)'}`,
      `- Scheduled cron runs: ${result.evidenceIds.cronRuns.join(', ') || '(none yet)'}`,
      '',
    );
  }
  lines.push(result.summary);
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// IO. Deliberately thin — everything above is pure and tested.
// -----------------------------------------------------------------------------

async function gh(path, token, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/**
 * Every completed run of a workflow for one event type, back to `since`.
 *
 * PAGINATES. The first version fetched a single page of 40, which cannot cover
 * a 24-hour window: the monitor runs every 30 minutes, so a clean window holds
 * ~48 observations and a failure at hour 2 would age out before hour 24. The
 * soak would then certify a window whose earliest hours it had never seen.
 *
 * Returns `{ runs, complete }`. `complete` is false when the page budget ran
 * out before reaching `since`, which the continuity gate reads as "this window
 * cannot be certified" rather than silently trusting a short history.
 */
async function runsFor(repo, token, workflow, event, since, maxPages = 6) {
  const runs = [];
  let complete = false;
  for (let page = 1; page <= maxPages; page++) {
    const data = await gh(
      `/repos/${repo}/actions/workflows/${workflow}/runs` +
        `?branch=main&event=${event}&per_page=100&page=${page}`,
      token,
    );
    const batch = data.workflow_runs ?? [];
    for (const r of batch) {
      if (r.status !== 'completed') continue;
      // normaliseRun() keeps `run_attempt` and separates the immutable
      // `created_at` from the rerun-mutable `updated_at`. A run KEEPS its
      // `schedule` event when a human presses "Re-run failed jobs", so the
      // event alone never distinguished delivery from a button press.
      const n = normaliseRun(r);
      runs.push({
        ...n,
        event: n.event ?? event,
        // Ordering and window membership use the time a rerun cannot move.
        // Using `updated_at` let a rerun drag a failure forward past a
        // recovery boundary the soak orders against.
        completedAt: n.scheduledAt,
        rerunCompletedAt: n.completedAt,
      });
    }
    if (batch.length === 0) {
      complete = true;
      break;
    }
    const oldest = batch.reduce(
      (min, r) => Math.min(min, new Date(r.updated_at).getTime()),
      Infinity,
    );
    if (since && oldest <= new Date(since).getTime()) {
      complete = true;
      break;
    }
    if (batch.length < 100) {
      complete = true;
      break;
    }
  }
  return { runs, complete };
}

/**
 * The production deployment, with everything needed to prove it is the one
 * serving customers — not merely one that exists.
 */
/**
 * Every ops-incident issue, paginated.
 *
 * A single `per_page=100` page is not the whole history, and the gap is a false
 * positive rather than a false negative: an old incident that is STILL OPEN
 * falling off page one makes the window pass when it should not. Workflow runs
 * were paginated in the previous round and incidents were not, which is the
 * kind of asymmetry that survives review because nobody states it.
 */
async function allIncidents(repo, token, maxPages = 10) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await gh(
      `/repos/${repo}/issues?state=all&labels=ops-incident&per_page=100&page=${page}`,
      token,
    );
    if (!batch || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out.map((i) => ({
    number: i.number,
    createdAt: i.created_at,
    // Retained so recovery can be required after the incident CLOSED rather
    // than when it opened.
    closedAt: i.closed_at ?? null,
    state: i.state,
  }));
}

async function currentDeployment(repo, token) {
  const deployments = await gh(
    `/repos/${repo}/deployments?environment=Production&per_page=1`,
    token,
  );
  const dep = deployments?.[0];
  if (!dep) return null;
  const statuses = await gh(`/repos/${repo}/deployments/${dep.id}/statuses?per_page=1`, token);
  const st = statuses?.[0];
  return {
    sha: dep.sha,
    id: String(dep.id),
    state: st?.state ?? null,
    environment: dep.environment ?? null,
    environmentUrl: st?.environment_url ?? null,
    // Filled in by the caller: host -> release SHA actually being served.
    aliasReleases: null,
  };
}

/**
 * Which release each canonical host is ACTUALLY serving.
 *
 * The previous version accepted any HTTP 200 and ignored the expected SHA it
 * was handed, so a healthy response from a completely different deployment
 * satisfied the alias gate — which is most of what the gate existed to catch.
 *
 * Follows redirects on purpose: `www.bookpitch.ge` answers 308 to the apex, so
 * what matters is the release at the FINAL destination. Returns a map of
 * host -> release SHA, with null for a host that could not be read at all, so
 * the caller can tell "serving the wrong release" from "no evidence".
 */
async function resolveAliasReleases(hosts) {
  const out = {};
  for (const host of hosts) {
    try {
      const res = await fetch(`https://${host}/api/health`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      out[host] = res.ok ? res.headers.get('x-bookpitch-release') || null : null;
    } catch {
      out[host] = null;
    }
  }
  return out;
}

/**
 * Re-verify the persisted Sentry receipt against Sentry's own API, every tick.
 *
 * The previous version read SOAK_SENTRY_RECEIPT_VERIFIED — a boolean an
 * operator ticked in the workflow form. This fetches both persisted event ids
 * and re-checks them with the same judgement scripts/verify-sentry.mjs uses
 * (lib/sentry-receipt.ts), so losing the DSNs, losing API access, or the
 * receipt no longer matching the deployed release all fail the gate — and a
 * failing gate puts the window into awaiting-recovery rather than coasting on
 * a verification done a day earlier.
 *
 * Returns `{ ok: false }` with a reason whenever anything is missing. Absence
 * is never agreement.
 */
async function verifySentryReceipt({ persisted, configured, releaseSha }) {
  const base = {
    configured,
    ok: false,
    serverEventId: persisted?.serverEventId ?? null,
    browserEventId: persisted?.browserEventId ?? null,
    problems: [],
  };
  if (!configured) {
    return { ...base, problems: ['production has no Sentry DSN configured'] };
  }
  const token = process.env.SENTRY_AUTH_TOKEN;
  const org = process.env.SENTRY_ORG;
  const project = process.env.SENTRY_PROJECT;
  if (!token || !org || !project) {
    return {
      ...base,
      problems: ['SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT are not set'],
    };
  }
  if (!persisted?.serverEventId || !persisted?.browserEventId || !persisted?.nonce) {
    return {
      ...base,
      problems: [
        'no verified server+browser event ids and nonce are persisted — run scripts/verify-sentry.mjs',
      ],
    };
  }

  // Re-authenticated on EVERY tick, not only the one that seeded it. The
  // receipt lives in a public issue body for 24 hours; checking it once at the
  // start would leave 47 ticks trusting whatever the body says now.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return {
      ...base,
      problems: ['CRON_SECRET is not set, so the receipt cannot be authenticated'],
    };
  }
  const integrity = verifyReceiptIntegrity(cronSecret, persisted);
  if (!integrity.ok) {
    return { ...base, problems: [`persisted receipt: ${integrity.reason}`] };
  }
  if (persisted.releaseSha !== releaseSha) {
    return {
      ...base,
      problems: [
        `the receipt was produced for ${String(persisted.releaseSha).slice(0, 12)} but the ` +
          `soak is measuring ${String(releaseSha).slice(0, 12)}`,
      ],
    };
  }

  const { verifyReceipt, verifyReceiptPair } = await import('./sentry-receipt.mjs');
  const fetchEvent = async (id) => {
    try {
      const res = await fetch(`https://sentry.io/api/0/projects/${org}/${project}/events/${id}/`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };

  const expectation = {
    releaseSha,
    environment: process.env.SENTRY_ENVIRONMENT ?? 'production',
    nonce: persisted.nonce,
    // The receipt must have been produced for THIS release. Re-verification
    // does not re-run the probe, so freshness is bounded by the recorded START
    // of the run — read through the accessor, never by picking a field.
    notBefore: soakFreshnessBound(persisted),
  };
  const server = verifyReceipt(await fetchEvent(persisted.serverEventId), {
    ...expectation,
    runtime: 'server',
  });
  const browser = verifyReceipt(await fetchEvent(persisted.browserEventId), {
    ...expectation,
    runtime: 'browser',
  });
  const pair = verifyReceiptPair({ server, browser });

  return {
    configured: true,
    ok: pair.ok,
    serverEventId: server.eventId,
    browserEventId: browser.eventId,
    problems: pair.problems,
  };
}

async function dryRun(repo, token) {
  const since = new Date(Date.now() - 26 * 3_600_000).toISOString();
  const findings = [];
  const ok = (name, detail) => findings.push({ name, ok: true, detail });
  const bad = (name, detail) => findings.push({ name, ok: false, detail });

  for (const [name, wf] of [
    ['actions:read production-monitor.yml', 'production-monitor.yml'],
    ['actions:read production-backup.yml', 'production-backup.yml'],
    ['actions:read cron.yml', 'cron.yml'],
  ]) {
    try {
      const { runs, complete } = await runsFor(repo, token, wf, 'schedule', since);
      ok(name, `${runs.length} scheduled runs since ${since}, history complete=${complete}`);
    } catch (err) {
      bad(name, err instanceof Error ? err.message : 'unknown');
    }
  }

  try {
    const dep = await currentDeployment(repo, token);
    if (!dep) bad('deployments:read', 'no Production deployment record found');
    else
      ok(
        'deployments:read',
        `deployment ${dep.id} sha=${String(dep.sha).slice(0, 7)} state=${dep.state} env=${dep.environment}`,
      );

    const aliases = await resolveAliasReleases(SOAK_DEFAULTS.requiredAliases);
    const unreadable = Object.entries(aliases)
      .filter(([, v]) => !v)
      .map(([h]) => h);
    if (unreadable.length)
      bad('alias release header', `no release reported by: ${unreadable.join(', ')}`);
    else {
      const matches = dep ? Object.values(aliases).every((v) => v === dep.sha) : false;
      (matches ? ok : bad)(
        'alias release header',
        Object.entries(aliases)
          .map(([h, v]) => `${h}=${String(v).slice(0, 7)}`)
          .join(' '),
      );
    }
  } catch (err) {
    bad('deployments:read', err instanceof Error ? err.message : 'unknown');
  }

  try {
    const issues = await allIncidents(repo, token);
    ok('issues:read ops-incident', `${issues.length} incident issues visible (paginated)`);
  } catch (err) {
    bad('issues:read ops-incident', err instanceof Error ? err.message : 'unknown');
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    bad('ops metrics', 'CRON_SECRET is not set, so outbox and heartbeat evidence cannot be read');
  } else {
    try {
      const target = process.env.MONITOR_PRODUCTION_URL ?? 'https://bookpitch.ge';
      const res = await fetch(`${target}/api/health/ops`, {
        headers: { authorization: `Bearer ${cronSecret}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) bad('ops metrics', `HTTP ${res.status}`);
      else {
        const m = (await res.json())?.metrics ?? {};
        const unhealthy = unhealthyJobsFrom(m?.cronHeartbeat?.jobs ?? null);
        const retentionAtIso =
          heartbeatSuccessAt(m?.cronHeartbeat?.jobs?.retention ?? null)?.toISOString() ?? null;
        ok(
          'ops metrics',
          `outboxDead=${m?.outbox?.dead ?? 'null'} ` +
            `unhealthyJobs=${unhealthy === null ? 'UNREADABLE' : JSON.stringify(unhealthy)} ` +
            `retentionSuccessAt=${retentionAtIso ?? 'null'}`,
        );
        // A dry run must exercise the JUDGEMENT, not only the fetch. Reporting
        // the raw map proved the endpoint answered; it did not prove the
        // contract could read it.
        if (unhealthy === null) {
          bad(
            'ops metrics',
            'the heartbeat job map is absent or unusable — the soak could not start',
          );
        }
      }
    } catch (err) {
      bad('ops metrics', err instanceof Error ? err.message : 'unknown');
    }
  }

  console.log('=== soak controller dry run — no state created or modified ===');
  for (const f of findings) console.log(`${f.ok ? 'OK  ' : 'FAIL'}  ${f.name} — ${f.detail}`);
  const failed = findings.filter((f) => !f.ok);
  console.log(`\n${findings.length - failed.length}/${findings.length} reads succeeded`);
  if (failed.length) {
    console.log('The controller would not be able to collect complete evidence.');
    process.exit(1);
  }
  console.log('Every read the controller depends on works. No soak was started.');
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.error('soak: GITHUB_TOKEN and GITHUB_REPOSITORY are required');
    process.exit(1);
  }

  if (process.env.SOAK_DRY_RUN === 'true') {
    await dryRun(repo, token);
    return;
  }

  const issues = await gh(
    `/repos/${repo}/issues?state=open&labels=${SOAK_LABEL}&per_page=20`,
    token,
  );
  const soakIssues = (issues ?? []).filter((i) => (i.body ?? '').includes(SOAK_MARKER));

  // Two soak issues means two windows, and whichever controller wrote last
  // wins. Refuse rather than pick.
  if (soakIssues.length > 1) {
    console.error(
      `soak: ${soakIssues.length} open soak issues (${soakIssues
        .map((i) => `#${i.number}`)
        .join(', ')}). Close all but one; two windows cannot both be authoritative.`,
    );
    process.exit(1);
  }

  let issue = soakIssues[0];
  let state = issue ? parseState(issue.body) : null;

  // A soak issue whose state cannot be parsed is worse than none: the window
  // start is unknown, so any elapsed time claimed from it is fabricated.
  if (issue && !state) {
    console.error(
      `soak: issue #${issue.number} carries the soak marker but no readable state. ` +
        'Refusing to invent a window start.',
    );
    process.exit(1);
  }

  // Authenticate the state BEFORE any gate reads it. The body is public and
  // editable between ticks, and optimistic concurrency only sees edits made
  // during one. An unsigned or edited state is refused outright rather than
  // being measured.
  if (issue && state) {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      console.error('soak: CRON_SECRET is not set, so the persisted state cannot be authenticated');
      process.exit(1);
    }
    const verdict = verifySoakState(secret, state, issue.created_at ?? null);
    if (!verdict.ok) {
      console.error(`soak: refusing to continue — ${verdict.reason}`);
      console.error(
        'The window recorded in this issue is not one this controller produced. Close the ' +
          'issue and start a new soak; do not edit the body to make it verify.',
      );
      process.exit(1);
    }
  }

  if (!state) {
    if (process.env.SOAK_START !== 'true') {
      console.log('soak: no open soak issue; nothing to do. This tick is not evidence.');
      return;
    }
    const sha = process.env.SOAK_RELEASE_SHA;
    if (!sha) {
      console.error('soak: SOAK_RELEASE_SHA is required to start a soak');
      process.exit(1);
    }
    // Starting while production is already unhealthy would begin a window that
    // is invalid from its first second.
    const openIncidents = await gh(
      `/repos/${repo}/issues?state=open&labels=ops-incident&per_page=50`,
      token,
    );
    if ((openIncidents ?? []).length > 0) {
      console.error(
        `soak: refusing to start with ${openIncidents.length} open production incident(s): ` +
          openIncidents.map((i) => `#${i.number}`).join(', '),
      );
      process.exit(1);
    }
    // The Sentry receipt is seeded HERE, at start, from the document
    // scripts/verify-sentry.mjs produced against this very release. It is the
    // only supported way evidence enters soak state — see seedSentryState().
    let seededSentry = null;
    const inlineReceipt = process.env.SOAK_SENTRY_RECEIPT;
    const receiptFile = process.env.SOAK_SENTRY_RECEIPT_FILE;
    try {
      const raw =
        inlineReceipt && inlineReceipt.trim() !== ''
          ? inlineReceipt
          : receiptFile
            ? (await import('node:fs')).readFileSync(receiptFile, 'utf8')
            : null;
      seededSentry = seedSentryState(raw);
    } catch (err) {
      console.error(`soak: refusing to start — ${err.message}`);
      process.exit(1);
    }
    if (!seededSentry) {
      console.error(
        'soak: refusing to start without a Sentry receipt.\n' +
          'The supported way to start a soak is the "Verify Sentry and start the soak"\n' +
          'workflow (.github/workflows/release-verify-and-soak.yml), which runs the real\n' +
          'probes and hands this controller the receipt file it produced. Starting without\n' +
          'one produces a window whose observability gate can never pass.',
      );
      process.exit(1);
    }
    // A receipt from a DIFFERENT release proves observability for code that is
    // no longer deployed. Caught here rather than on tick one, where it would
    // read as a production fault.
    if (seededSentry.releaseSha !== sha) {
      console.error(
        `soak: the Sentry receipt was produced for ${seededSentry.releaseSha.slice(0, 12)} but ` +
          `this soak is for ${sha.slice(0, 12)}. Re-run the probe against the deployed release.`,
      );
      process.exit(1);
    }

    const startedAt = new Date().toISOString();
    state = {
      tickSeq: 0,
      releaseSha: sha,
      deploymentId: process.env.SOAK_DEPLOYMENT_ID ?? null,
      startedAt,
      effectiveWindowStart: startedAt,
      awaitingRecoverySince: null,
      restarts: [],
      lastProcessedMonitorRun: null,
      sentry: seededSentry,
      lastTickAt: null,
    };
    state.stateDigest = soakStateDigest(process.env.CRON_SECRET, state);
    issue = await gh(`/repos/${repo}/issues`, token, {
      method: 'POST',
      body: JSON.stringify({
        title: `[soak] 24-hour production soak — ${sha.slice(0, 7)}`,
        body: renderState(state),
        labels: [SOAK_LABEL],
      }),
    });
    console.log(`soak: started, issue #${issue.number}`);
  }

  const windowStart = state.effectiveWindowStart ?? state.startedAt;
  const [monitor, backup, cron, incidents] = await Promise.all([
    runsFor(repo, token, 'production-monitor.yml', 'schedule', windowStart),
    runsFor(repo, token, 'production-backup.yml', 'schedule', windowStart),
    runsFor(repo, token, 'cron.yml', 'schedule', windowStart),
    allIncidents(repo, token),
  ]);

  let deployment = null;
  try {
    deployment = await currentDeployment(repo, token);
    if (deployment) {
      deployment.aliasReleases = await resolveAliasReleases(SOAK_DEFAULTS.requiredAliases);
    }
  } catch {
    /* null → the evaluator blocks, which is the point */
  }

  let outboxDead = null;
  let unhealthyJobs = null;
  let retentionSuccessAt = null;
  let sentryConfigured = false;
  const cronSecret = process.env.CRON_SECRET;
  const target = process.env.MONITOR_PRODUCTION_URL ?? 'https://bookpitch.ge';
  if (cronSecret) {
    try {
      const res = await fetch(`${target}/api/health/ops`, {
        headers: { authorization: `Bearer ${cronSecret}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const body = await res.json();
        const m = body?.metrics ?? body;
        outboxDead = m?.outbox?.dead ?? null;
        sentryConfigured = (m?.config?.missingObservabilityEnv ?? null) === 0;

        // Per-job, not the old scalar. `unhealthyJobs` stays NULL when the map
        // is absent, and the gate reads null as "could not be read" rather than
        // as zero problems — a deployment that predates per-job reporting must
        // not certify a window.
        // Judged against the SHARED contract (scripts/heartbeat-contract.mjs),
        // not against the keys and limits this response happens to carry.
        //
        // This used to iterate Object.entries(jobs) and compare against
        // j.maxAgeMinutes — the same defect the monitor had, on the gate that
        // decides whether a whole 24-hour window counts. A deployment that
        // stopped reporting `retention` dropped it silently from the soak's
        // health check, and one reporting a generous limit was graded against
        // its own generosity for a day.
        unhealthyJobs = unhealthyJobsFrom(m?.cronHeartbeat?.jobs ?? null);

        // The nightly sweep's success age, kept as a number so the gate can
        // turn it into an instant and compare it against the effective window
        // start. `cron-outcomes` only asks whether it is inside retention's
        // 30-hour freshness limit, and 30 hours is longer than the window.
        // The ABSOLUTE instant the database recorded, not an age subtracted
        // from this runner's clock. Reconstructing it locally mixed
        // PostgreSQL's NOW() with GitHub's — two machines, on the comparison
        // that decides whether the nightly sweep landed inside the window.
        const retentionAt = heartbeatSuccessAt(m?.cronHeartbeat?.jobs?.retention ?? null);
        retentionSuccessAt = retentionAt ? retentionAt.toISOString() : null;
      }
    } catch {
      /* null → gates read it as "not evidence of health" */
    }
  }

  // Revalidated against Sentry on every tick, using the persisted event ids and
  // the same pure judgement the verification script uses. Trusting a persisted
  // boolean is what the previous version did.
  const sentry = await verifySentryReceipt({
    persisted: state.sentry ?? null,
    configured: sentryConfigured,
    releaseSha: state.releaseSha,
  });

  const result = evaluateSoak({
    state,
    evidence: {
      monitorRuns: monitor.runs,
      backupRuns: backup.runs,
      cronRuns: cron.runs,
      historyComplete: monitor.complete && backup.complete && cron.complete,
      incidents: incidents ?? [],
      deployment,
      sentry,
      outboxDead,
      unhealthyJobs,
      retentionSuccessAt,
    },
  });

  const nextState = {
    ...state,
    awaitingRecoverySince: result.awaitingRecoverySince ?? null,
    // The whole point: the restarted window is written down, so the next tick
    // starts from here even after the failing run ages out of history.
    effectiveWindowStart: result.effectiveWindowStart ?? windowStart,
    restarts: result.restarts,
    lastProcessedMonitorRun:
      result.lastProcessedMonitorRun ?? state.lastProcessedMonitorRun ?? null,
    sentry: nextSentryState(state.sentry ?? null, sentry),
    // Monotonic, and signed: it exists so a replayed older body is visibly
    // older rather than merely different.
    tickSeq: (typeof state.tickSeq === 'number' ? state.tickSeq : 0) + 1,
    lastTickAt: new Date().toISOString(),
  };
  // Re-signed on every write. The controller is the only thing that can do
  // this, which is what makes an edited body detectable rather than merely
  // unlikely.
  nextState.stateDigest = soakStateDigest(process.env.CRON_SECRET, nextState);

  // Optimistic concurrency: refuse to write over a body that changed since it
  // was read, so two controllers cannot interleave conflicting windows.
  const fresh = await gh(`/repos/${repo}/issues/${issue.number}`, token);
  if ((fresh?.body ?? '') !== (issue.body ?? '') && state.lastTickAt) {
    console.error(
      'soak: issue state changed while this tick was running — another controller is active',
    );
    process.exit(1);
  }

  await gh(`/repos/${repo}/issues/${issue.number}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ body: renderState(nextState) }),
  });
  await gh(`/repos/${repo}/issues/${issue.number}/comments`, token, {
    method: 'POST',
    body: JSON.stringify({ body: renderReport(nextState, result) }),
  });

  console.log(renderReport(nextState, result));

  if (
    result.status === 'success' ||
    result.status === 'superseded' ||
    result.status === 'blocked'
  ) {
    await gh(`/repos/${repo}/issues/${issue.number}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
  }
}

const isEntrypoint =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(`soak: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  });
}
