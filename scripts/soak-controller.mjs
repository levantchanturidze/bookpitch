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
import {
  normaliseRun,
  isNaturalObservation,
  isNaturalSuccess,
  isUnknownObservation,
  isJudgeable,
  resolveRun,
} from './run-evidence.mjs';
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
  /**
   * How old the most recent FRESH observability proof may be.
   *
   * Re-fetching the same two events every tick proves they are still readable.
   * It proves nothing about ingestion: revoke the DSN at hour 3, exhaust a
   * quota, add an inbound filter or break the transport, and those two events
   * stay perfectly readable for the whole window while nothing new can arrive.
   *
   * CALIBRATED, and separately from the refresh cadence — which is the defect
   * this replaces. Expiry and cadence were both six hours, leaving exactly zero
   * margin for GitHub's scheduling delay, npm install, Chromium install, Sentry
   * indexing, or queue time. Any one of those made the gate fail for reasons
   * that had nothing to do with production.
   *
   * Measured scheduled-delivery lag on this account: p95 4.13h, p99 5.03h.
   * Verifier runtime is roughly ten minutes. With a 4-hour cadence:
   *
   *   normal, p99 lag        4 + 5.03 + 0.17 =  9.20h
   *   one dropped schedule   8 + 4.13 + 0.17 = 12.30h
   *
   * 14h is the smallest expiry that survives a dropped schedule at p95 lag,
   * with ~1.7h to spare and ~4.8h in the normal worst case. Two consecutive
   * dropped schedules exceed it — deliberately: that is a scheduler outage, and
   * a window nobody was proving ingestion for is not one to certify.
   *
   * Cost: 6 probe pairs a day, 12 synthetic events. A soak that exhausts the
   * Sentry quota has broken the thing it was measuring.
   */
  maxObservabilityProofAgeHours: 14,
  /**
   * How often `sentry-reverify.yml` aims to refresh the proof. Documented here
   * so the two numbers are visibly related and cannot drift into equality
   * again; the schedule itself lives in the workflow.
   */
  observabilityRefreshCadenceHours: 4,
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
  'observability-continuing',
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
  'evidence-resolved',
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
 * The persisted-state schema version.
 *
 * Bound into the digest, so a state written by a different shape of controller
 * is refused rather than half-understood. Bump it whenever the semantic field
 * set changes.
 */
export const SOAK_STATE_VERSION = 1;

/**
 * The ONLY fields excluded from the signature, because they decide nothing.
 *
 * Everything else is semantic and is signed. This list is deliberately an
 * exclusion rather than an inclusion: the previous design enumerated the
 * *included* top-level names, and any such list is one nested value behind the
 * code that reads them. It was — `sentry.lastFreshProofAt` was the single value
 * the observability-continuing gate read, and it was covered by neither HMAC.
 */
export const SOAK_PRESENTATION_FIELDS = Object.freeze(['lastTickAt']);

/** Top-level keys a state may carry. Anything else is refused, not ignored. */
export const SOAK_SEMANTIC_FIELDS = Object.freeze([
  'awaitingRecoverySince',
  'deploymentId',
  'effectiveWindowStart',
  'lastProcessedMonitorRun',
  'releaseSha',
  'restarts',
  'schemaVersion',
  'sentry',
  'startedAt',
  'tickSeq',
]);

/**
 * Deterministic serialisation, to any depth.
 *
 * Object keys sorted; arrays kept in order because their order is meaningful
 * (`restarts` is a history). Types are explicit, so `1` and `"1"` do not
 * collide.
 */
function canonicalise(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`)
      .join(',')}}`;
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

/** The semantic half of a state — everything the digest covers. */
function semanticState(state) {
  const out = {};
  for (const key of Object.keys(state ?? {})) {
    if (key === 'stateDigest') continue;
    if (SOAK_PRESENTATION_FIELDS.includes(key)) continue;
    out[key] = state[key];
  }
  return out;
}

/**
 * HMAC over the schema version and a canonical DEEP serialisation of every
 * semantic value — nested Sentry fields, restart entries, all of it.
 */
export function soakStateDigest(secret, state) {
  // An absent secret must not silently produce a digest over the string
  // "undefined" — signing and verifying would both do it and agree, which is a
  // signature scheme that authenticates nothing.
  if (!secret || typeof secret !== 'string') {
    throw new Error('soakStateDigest requires CRON_SECRET; refusing to sign with an empty key');
  }
  return createHmac('sha256', secret)
    .update(`v${SOAK_STATE_VERSION}\n${canonicalise(semanticState(state))}`)
    .digest('hex');
}

/**
 * How old the Sentry proof is, in hours — or null when it cannot be trusted.
 *
 * Derived from `sentry.verifiedAt`, which the VERIFIER wrote and the receipt
 * digest covers. The controller used to stamp its own `lastFreshProofAt` from
 * its local clock, outside both HMACs, so the value the freshness gate read was
 * the one value nothing authenticated.
 *
 * Null for: absent, malformed, or implausibly future. A future timestamp
 * produced a NEGATIVE age, which passed `age <= limit` — future-dating the
 * field made the gate greener than green.
 */
export const SENTRY_PROOF_MAX_SKEW_MINUTES = 5;

export function sentryProofAge(sentry, now) {
  const raw = sentry?.verifiedAt;
  const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(at)) return null;
  const ageH = (now.getTime() - at) / 3_600_000;
  // A little forward skew is ordinary between a runner and this process; a lot
  // is a clock problem or a forged timestamp, and either way it is not
  // evidence of freshness.
  if (ageH < -(SENTRY_PROOF_MAX_SKEW_MINUTES / 60)) return null;
  return Math.max(0, ageH);
}

/**
 * Is this persisted state authentic, complete, and anchored to reality?
 *
 * @param {string} secret
 * @param {object} state
 * @param {string|null} [issueCreatedAt]  the soak issue's creation time, from
 *   GitHub. Optional only so the signature and schema checks can be exercised
 *   on their own; the controller always passes it, and the window-vs-issue
 *   comparison below is skipped without it.
 */
export function verifySoakState(secret, state, issueCreatedAt) {
  if (!state || typeof state !== 'object') return { ok: false, reason: 'no state' };

  // Unknown fields are REFUSED. Ignoring one is how a value gets added, read by
  // a gate, and never covered by the signature.
  const known = new Set([...SOAK_SEMANTIC_FIELDS, ...SOAK_PRESENTATION_FIELDS, 'stateDigest']);
  const unknown = Object.keys(state).filter((k) => !known.has(k));
  if (unknown.length) {
    return {
      ok: false,
      reason:
        `the soak state carries unknown field(s): ${unknown.join(', ')} — refusing rather ` +
        'than measuring a document this controller does not fully understand',
    };
  }

  if (state.schemaVersion !== SOAK_STATE_VERSION) {
    return {
      ok: false,
      reason:
        `the soak state is schema v${state.schemaVersion ?? '(none)'}, this controller ` +
        `writes v${SOAK_STATE_VERSION}`,
    };
  }

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

  // The window cannot begin before the issue recording it. An older validly
  // signed body carries an earlier window, which is more elapsed time.
  if (issueCreatedAt) {
    const issueAt = Date.parse(issueCreatedAt);
    const windowAt = Date.parse(state.effectiveWindowStart ?? state.startedAt ?? '');
    const startedAt = Date.parse(state.startedAt ?? '');
    if (!Number.isFinite(issueAt) || !Number.isFinite(windowAt) || !Number.isFinite(startedAt)) {
      return { ok: false, reason: 'the soak state carries no usable window timestamps' };
    }
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

// -----------------------------------------------------------------------------
// Replay protection: a monotonic checkpoint chain outside the issue BODY.
//
// Signing the state stops edits. It does not stop REPLAY — restoring an earlier
// valid body of the same issue. That body carries a genuine signature, a window
// that postdates the issue, and a state from before a release-critical failure:
// the restart is erased and the clock resumes from the older window.
//
// A signed `tickSeq` cannot help by itself, because the attacker restores the
// body containing the older `tickSeq` and there is nothing to compare it
// against. It needs an external monotonic reference the body cannot rewrite.
//
// GitHub issue COMMENTS are that reference: their ids are monotonic, and they
// are not part of the body. Each tick posts one carrying `tickSeq` and the
// state digest, which makes four attacks visible:
//
//   rollback     the newest checkpoint's digest does not match the body;
//   deletion     tickSeq values must be contiguous, so a hole shows;
//   forking      two checkpoints claiming one tick;
//   reordering   comment id order must agree with tickSeq order.
//
// TRUST BOUNDARY, stated plainly because an overstated one is worse than none.
//
// The body and the comments are BOTH mutable by anyone with repository write,
// and the checkpoint carries no secret of its own — only a digest the
// controller produced earlier. So an actor with that access can delete every
// comment after tick N and restore the tick-N body, and the result is a
// complete, internally consistent, correctly signed chain that ends at N. It is
// indistinguishable from a soak that genuinely stopped at N, and nothing in
// this file can tell the difference.
//
// What the chain therefore DOES buy:
//
//   * a body rolled back on its own, with the comments left alone, is caught;
//   * a checkpoint deleted, forked or reordered is caught;
//   * a tick that wrote its body but not its checkpoint is caught;
//   * every one of those is caught mechanically, on the next tick, with no
//     operator vigilance required.
//
// What it does NOT buy: protection against a determined actor holding
// repository write, which is administrator-level access to the very records
// being used as evidence. Defending that would need an append-only store
// outside GitHub, and standing up such a thing is a larger project than this
// soak — so it is named as a limit, not quietly implied away. Where the
// construction ends, the controller stops rather than guessing.
// -----------------------------------------------------------------------------

const CHECKPOINT_MARKER = '<!-- bookpitch-soak-checkpoint -->';

/** One checkpoint, as an issue comment body. Carries no secrets. */
export function renderCheckpoint({ tickSeq, stateDigest }) {
  return (
    `${CHECKPOINT_MARKER}\n` +
    `tick ${tickSeq} · state ${stateDigest}\n\n` +
    '<sub>Written by the soak controller. It exists so that restoring an older issue body ' +
    'is detectable: comment ids are monotonic and are not part of the body.</sub>'
  );
}

/** Read a checkpoint back, or null when the comment is not one. */
export function parseCheckpoint(body) {
  if (typeof body !== 'string' || !body.includes(CHECKPOINT_MARKER)) return null;
  const m = /tick (\d+) · state ([0-9a-f]{64})/.exec(body);
  return m ? { tickSeq: Number(m[1]), stateDigest: m[2] } : null;
}

/**
 * Does the chain of checkpoints agree that this state is the current one?
 *
 * @param {Array<{id:number, body:string}>} comments  every comment on the issue
 * @param {{tickSeq:number, stateDigest:string}} state
 * @param {{complete?: boolean}} [options]  `complete: false` means the comment
 *   list was truncated by the page budget, which is refused outright.
 */
export function verifyCheckpointChain(comments, state, options = {}) {
  const chain = (comments ?? [])
    .map((c) => ({ id: c.id, cp: parseCheckpoint(c.body) }))
    .filter((c) => c.cp)
    .sort((a, b) => a.id - b.id);

  const tickSeq = typeof state?.tickSeq === 'number' ? state.tickSeq : -1;

  // A capped read is not a history. GitHub returns issue comments oldest first,
  // so running out of page budget drops the NEWEST checkpoints — leaving an old
  // tip that the body legitimately sits ahead of. Every check below reasons
  // about the tip, so they are all wrong on a truncated list.
  if (options.complete === false) {
    return {
      ok: false,
      reason:
        'the checkpoint comment history could not be read in full — the page budget ran out, ' +
        'and GitHub returns comments oldest first, so the MOST RECENT checkpoints are the ones ' +
        'missing. A partial history cannot establish the chain tip',
    };
  }

  if (chain.length === 0) {
    // A soak that has never ticked has nothing to prove yet. One that has is
    // missing its entire history, which is not a state to keep measuring.
    if (tickSeq === 0) return { ok: true };
    return {
      ok: false,
      reason:
        `the state claims tick ${tickSeq} but no checkpoint comments exist — the chain that ` +
        'would make a replayed body detectable has been removed',
    };
  }

  // Contiguity: every tick from the first recorded to the last must be present.
  const seqs = chain.map((c) => c.cp.tickSeq);
  const seen = new Set();
  for (const n of seqs) {
    if (seen.has(n)) {
      return { ok: false, reason: `tick ${n} is checkpointed twice — the chain has forked` };
    }
    seen.add(n);
  }
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] < seqs[i - 1]) {
      return {
        ok: false,
        reason:
          `checkpoint order disagrees with comment order: tick ${seqs[i]} was posted after ` +
          `tick ${seqs[i - 1]}`,
      };
    }
    if (seqs[i] !== seqs[i - 1] + 1) {
      return {
        ok: false,
        reason:
          `a gap in the checkpoint chain: tick ${seqs[i - 1]} is followed by ${seqs[i]}. ` +
          'A missing checkpoint means one was deleted',
      };
    }
  }

  const latest = chain[chain.length - 1].cp;
  if (tickSeq < latest.tickSeq) {
    return {
      ok: false,
      reason:
        `the state is at tick ${tickSeq}, older than the latest checkpoint (tick ` +
        `${latest.tickSeq}) — the issue body was rolled back`,
    };
  }
  if (tickSeq > latest.tickSeq) {
    // The body was written and its checkpoint was not.
    //
    // The persistence order is body first, checkpoint second, and the comment
    // at that call site claimed "a failure between the two leaves a body
    // without its checkpoint — which the next tick reads as a gap and refuses."
    // It did not. This branch fell through to `ok: true`, so the one crash the
    // ordering was designed around was the one case that passed silently — and
    // the tick it certified had no external anchor at all, which is precisely
    // what the chain exists to provide.
    //
    // No recovery protocol is offered, deliberately. Re-anchoring the tick here
    // would mean writing the missing checkpoint from the same state that is
    // under suspicion, which proves nothing it did not already assume. A window
    // with a hole in its state history is not certifiable; starting a fresh
    // soak is cheap and honest.
    const missing =
      tickSeq - latest.tickSeq === 1 ? `tick ${tickSeq}` : `ticks ${latest.tickSeq + 1}–${tickSeq}`;
    return {
      ok: false,
      reason:
        `the state is at tick ${tickSeq} but the chain ends at tick ${latest.tickSeq} — ` +
        `${missing} was never checkpointed. Either a tick wrote its body and died before its ` +
        'checkpoint, or the checkpoint was removed; the two are indistinguishable from here',
    };
  }
  if (tickSeq === latest.tickSeq && state.stateDigest !== latest.stateDigest) {
    return {
      ok: false,
      reason: `the state at tick ${tickSeq} does not match its own checkpoint`,
    };
  }
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Provenance for the continuing-observability proof.
//
// `sentry-reverify.yml` allowed `workflow_dispatch`, and neither the workflow
// nor the controller looked at how it had been triggered. So the one gate that
// proves production is STILL ingesting events could be refreshed by pressing a
// button, or by re-running a failed refresh until it passed. That is the
// manual-evidence defect the whole project keeps finding, on its newest gate.
//
// Two rules, and the second is the one that matters:
//
//   1. only a scheduled, first-attempt run may refresh the proof;
//   2. that is confirmed against GitHub's own run record, not read from the
//      environment. A workflow file can be edited and `GITHUB_EVENT_NAME` is
//      just a string; the API record is not ours to write.
//
// The provenance is then bound into the persisted state, which the state digest
// covers, so a later reader can see exactly which run produced the proof.
// -----------------------------------------------------------------------------

/** The provenance recorded alongside a refreshed receipt. */
export function reverifyProvenance(env, apiRun, receipt) {
  return {
    event: apiRun?.event ?? null,
    runId: apiRun?.id ?? null,
    runAttempt: apiRun?.run_attempt ?? null,
    runCreatedAt: apiRun?.created_at ?? null,
    headSha: apiRun?.head_sha ?? null,
    verifiedAt: receipt?.verifiedAt ?? null,
    releaseSha: receipt?.releaseSha ?? null,
  };
}

/**
 * May this run refresh the soak's observability proof?
 *
 * @param {Record<string,string|undefined>} env  the workflow's own claims
 * @param {Record<string,any>|null} apiRun       GitHub's record of the same run
 * @param {{verifiedAt?: string|null}|null} persisted  the proof already held
 * @param {{verifiedAt?: string|null, releaseSha?: string|null}} receipt
 */
export function verifyReverifyProvenance(env, apiRun, persisted, receipt) {
  if (!apiRun) {
    return {
      ok: false,
      reason: "GitHub's record of this run could not be read, so its provenance is unconfirmed",
    };
  }

  // The environment's claims, checked first so the message names what the
  // caller thought it was doing.
  if (env?.GITHUB_EVENT_NAME !== 'schedule') {
    return {
      ok: false,
      reason:
        `this run was triggered by ${env?.GITHUB_EVENT_NAME ?? 'an unknown event'}, not the ` +
        'schedule. A refresh started by hand is diagnostic; it is not evidence of unattended ' +
        'operation',
    };
  }
  if (env?.GITHUB_RUN_ATTEMPT !== '1') {
    return {
      ok: false,
      reason: `this is run attempt ${env?.GITHUB_RUN_ATTEMPT ?? '(unknown)'}; a re-run is not unattended`,
    };
  }

  // …and now the same facts from GitHub, which is the half that cannot be
  // forged by editing a workflow file.
  if (String(apiRun.id) !== String(env.GITHUB_RUN_ID)) {
    return { ok: false, reason: 'the run record fetched is not the run claiming to refresh' };
  }
  if (apiRun.event !== 'schedule' || (apiRun.run_attempt ?? 0) !== 1) {
    return {
      ok: false,
      reason:
        `GitHub disagrees with the environment: it records event ${apiRun.event}, attempt ` +
        `${apiRun.run_attempt}`,
    };
  }
  if (!apiRun.head_sha || apiRun.head_sha !== receipt?.releaseSha) {
    return {
      ok: false,
      reason:
        `the refreshing run is on ${String(apiRun.head_sha).slice(0, 12)} but the receipt is ` +
        `for ${String(receipt?.releaseSha).slice(0, 12)}`,
    };
  }

  const verifiedAt = receipt?.verifiedAt ? Date.parse(receipt.verifiedAt) : NaN;
  if (!Number.isFinite(verifiedAt)) {
    return { ok: false, reason: 'the receipt carries no usable verification time' };
  }
  // The receipt must have been produced BY this run, so its verification cannot
  // predate the run's own start.
  const runStarted = apiRun.created_at ? Date.parse(apiRun.created_at) : NaN;
  if (Number.isFinite(runStarted) && verifiedAt < runStarted) {
    return {
      ok: false,
      reason:
        `the receipt was verified at ${receipt.verifiedAt}, before the run started at ` +
        `${apiRun.created_at} — this run did not produce it`,
    };
  }
  // And it must be NEWER than the proof already held, or an old receipt could
  // be restamped and reset the freshness clock indefinitely.
  const previous = persisted?.verifiedAt ? Date.parse(persisted.verifiedAt) : NaN;
  if (Number.isFinite(previous) && verifiedAt <= previous) {
    return {
      ok: false,
      reason:
        `the receipt is older than, or the same age as, the proof already held ` +
        `(${receipt.verifiedAt} vs ${persisted.verifiedAt}) — a stale receipt cannot be ` +
        'restamped as fresh',
    };
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
 *              browserEventId: string|null, problems?: string[],
 *              verifiedAt?: string|null} | null,
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
      // An unreadable first attempt is not an observed failure and must not
      // restart the window — that would invent a failure from a GitHub API
      // error. It is not a success either: the `evidence-resolved` gate below
      // blocks certification while any remain.
      if (isUnknownObservation(r)) continue;
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

  // Scheduled runs inside the window whose authoritative first attempt could
  // not be read, from every source. These used to disappear before reaching any
  // gate: `resolveRun` marked them `unresolved` but left the LATEST attempt's
  // number on them, and the observation filter required attempt 1. Reproduced
  // through this function — with enough clean observations either side, an
  // unreadable in-window first attempt returned `success`, while retrieving
  // that same attempt as a failure restarted the window. The outcome decided
  // the verdict, and not being able to read the outcome decided it too, the
  // other way.
  const unknownRuns = [
    ...after(scheduled(evidence.monitorRuns), windowStart).filter(isUnknownObservation),
    ...after(scheduled(evidence.backupRuns), windowStart).filter(isUnknownObservation),
    ...after(scheduled(evidence.cronRuns), windowStart).filter(isUnknownObservation),
  ];
  const unknownIds = unknownRuns.map((r) => r.runId);
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
      // Unknowns are excluded here on purpose. `monitor-clean` is a HEALTH
      // gate: failing it restarts the window, which is the right response to an
      // observed failure and the wrong response to a GitHub read error. The
      // `evidence-resolved` gate blocks the verdict instead, without discarding
      // hours of legitimate evidence over a transient API fault.
      ok: observations.filter((r) => !isUnknownObservation(r)).length === cleanObservations.length,
      detail:
        `${observations.filter((r) => !isUnknownObservation(r)).length - cleanObservations.length}` +
        ` non-successful observations in the window` +
        (unknownRuns.length ? ` (${unknownRuns.length} unreadable, counted separately)` : ''),
    },
    {
      id: 'evidence-resolved',
      // Unknown is not health, and it is not failure either. It blocks.
      ok: unknownRuns.length === 0,
      detail:
        unknownRuns.length === 0
          ? 'every scheduled run in the window has a readable first-attempt outcome'
          : `${unknownRuns.length} scheduled run(s) in the window were re-run and their first ` +
            `attempt could not be retrieved: ${unknownIds.join(', ')}. Their real outcome is ` +
            'unknown, so this window cannot be certified either way. It does NOT restart the ' +
            'window — a GitHub read error is not a production failure. If the attempt stays ' +
            'unreadable, start a fresh soak rather than certifying around it.',
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
      id: 'observability-continuing',
      // Ongoing ingestion, not merely ongoing readability.
      //
      // The `observability` gate below re-checks the two events the receipt
      // names. They were created before the window began, and they stay
      // readable through Sentry's API no matter what happens to ingestion
      // afterwards — so on its own it certifies 24 hours on a verification done
      // at hour zero.
      ...(() => {
        const limitH = opts.maxObservabilityProofAgeHours;
        // From the VERIFIER's own signed completion time, not from a value the
        // controller stamped with its local clock. `lastFreshProofAt` was
        // outside both HMACs, so the one value this gate read was the one value
        // nothing authenticated — and a future date produced a negative age
        // that passed `age <= limit`.
        const ageH = sentryProofAge(evidence.sentry, now);
        if (ageH === null) {
          return {
            ok: false,
            detail:
              'no usable observability proof timestamp — absent, malformed, or implausibly ' +
              'future. Re-fetching the original events shows they are still readable, which is ' +
              'not evidence that new ones can be ingested',
          };
        }
        // AGE only, deliberately — not "inside the window".
        //
        // Requiring the proof to postdate the window start looks stricter and
        // livelocks: a restart begins a new window, every existing proof
        // predates it, the gate fails, the failure is a HEALTH gate, and the
        // soak returns to awaiting-recovery — forever.
        //
        // The age limit already gives the stronger property where it matters.
        // Success needs `window-elapsed` at 24h, and the cadence is 6h, so any
        // proof recent enough to satisfy this gate at success time is
        // necessarily inside the window by a margin of 18 hours. The
        // in-window clause was redundant exactly when it would have mattered
        // and harmful the rest of the time.
        return {
          ok: ageH <= limitH,
          detail:
            ageH > limitH
              ? `the most recent fresh proof is ${ageH.toFixed(1)}h old, limit ${limitH}h — stale. ` +
                'Re-fetching the original events shows only that they are still readable'
              : `fresh events ingested ${ageH.toFixed(1)}h ago (limit ${limitH}h)`,
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
    sourceMapAssets: persisted?.sourceMapAssets ?? null,
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
    'sourceMapAssets',
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
    // WHICH assets the public-map check covered. Bound so a receipt that
    // checked the landing page's chunks cannot pass as one that checked the
    // probe's own bundles.
    sourceMapAssets: r.sourceMapAssets,
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
/**
 * Every page of a list endpoint, and whether that is genuinely every page.
 *
 * `complete` matters. GitHub returns issue comments OLDEST FIRST, so exhausting
 * the page budget drops the NEWEST ones — the recent checkpoints. The chain
 * verifier would then see an old tip, conclude the state body was merely ahead
 * of it, and pass. A capped read must never be presented as a complete history.
 *
 * @returns {Promise<{items: any[], complete: boolean}>}
 */
async function ghAll(path, token, maxPages = 10) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = await gh(`${path}${sep}per_page=100&page=${page}`, token);
    if (!Array.isArray(batch) || batch.length === 0) return { items: out, complete: true };
    out.push(...batch);
    if (batch.length < 100) return { items: out, complete: true };
  }
  // The budget ran out on a full page: there may be more, and what is missing
  // is the most recent.
  return { items: out, complete: false };
}

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
      // A re-run record is replaced by its authoritative FIRST attempt, fetched
      // from GitHub. Dropping it instead — which the first fix did — erased the
      // original failure from the window entirely, and the surrounding
      // successes carried the gate.
      //
      // RESOLVE BEFORE JUDGING COMPLETENESS. The `status !== 'completed'` skip
      // used to sit above this, and a re-run carries the LATEST attempt's
      // status: starting a re-run and not waiting for it was enough to drop the
      // record, first attempt and all.
      const authoritative =
        (r.run_attempt ?? 1) > 1
          ? await resolveRun(r, async (id) =>
              gh(`/repos/${repo}/actions/runs/${id}/attempts/1`, token).catch(() => null),
            )
          : null;
      if (!isJudgeable(authoritative ?? r)) continue;
      // normaliseRun() keeps `run_attempt` and separates the immutable
      // `created_at` from the rerun-mutable `updated_at`. A run KEEPS its
      // `schedule` event when a human presses "Re-run failed jobs", so the
      // event alone never distinguished delivery from a button press.
      const n = authoritative ?? normaliseRun(r);
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
    // Pagination boundary on the IMMUTABLE timestamp. `updated_at` moves when
    // a run is re-run, so a re-run could push the boundary forward and stop the
    // fetch before it reached the window start.
    const oldest = batch.reduce(
      (min, r) => Math.min(min, new Date(r.created_at ?? r.updated_at).getTime()),
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

    // A valid signature does not mean this is the CURRENT state: an earlier
    // valid body of the same issue carries one too. The checkpoint comments are
    // the external monotonic reference the body cannot rewrite.
    const { items: comments, complete: commentsComplete } = await ghAll(
      `/repos/${repo}/issues/${issue.number}/comments`,
      token,
    );
    const chain = verifyCheckpointChain(comments, state, { complete: commentsComplete });
    if (!chain.ok) {
      console.error(`soak: refusing to continue — ${chain.reason}`);
      console.error(
        'The checkpoint chain does not agree that this is the current state. Close the issue ' +
          'and start a new soak.',
      );
      process.exit(1);
    }
  }

  // Re-verification mode: a fresh receipt for an EXISTING soak.
  //
  // The observability-continuing gate needs proof that new events can still be
  // ingested, not merely that the original two remain readable. A separate
  // scheduled workflow runs the full verifier every few hours and hands the
  // result here; this replaces the sentry block, re-signs the state, and
  // touches nothing else — the window, the restarts and the deployment pin are
  // not the verifier's business.
  if (state && process.env.SOAK_REVERIFY === 'true') {
    const file = process.env.SOAK_SENTRY_RECEIPT_FILE;
    if (!file) {
      console.error('soak: SOAK_REVERIFY=true requires SOAK_SENTRY_RECEIPT_FILE');
      process.exit(1);
    }
    let seeded;
    try {
      seeded = seedSentryState((await import('node:fs')).readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`soak: refusing the re-verification receipt — ${err.message}`);
      process.exit(1);
    }
    if (!seeded || seeded.releaseSha !== state.releaseSha) {
      console.error(
        `soak: the re-verification receipt is for ${seeded?.releaseSha?.slice(0, 12) ?? '(none)'}, ` +
          `but this soak measures ${String(state.releaseSha).slice(0, 12)}.`,
      );
      process.exit(1);
    }

    // Provenance, confirmed against GitHub rather than read from the
    // environment. Only a scheduled first-attempt run may advance the
    // continuing-observability proof; a dispatch or a re-run is diagnostic and
    // must not touch authoritative state.
    const apiRun = process.env.GITHUB_RUN_ID
      ? await gh(`/repos/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`, token).catch(
          () => null,
        )
      : null;
    const provenance = verifyReverifyProvenance(process.env, apiRun, state.sentry ?? null, seeded);
    if (!provenance.ok) {
      console.error(`soak: refusing to refresh the observability proof — ${provenance.reason}`);
      console.error(
        'The verification above may still be useful as a diagnostic; it is simply not ' +
          'evidence of unattended operation, and the soak state is unchanged.',
      );
      process.exit(1);
    }
    const refreshed = {
      ...state,
      // The provenance is inside the state digest, so a later reader can see
      // exactly which scheduled run produced this proof.
      sentry: { ...seeded, provenance: reverifyProvenance(process.env, apiRun, seeded) },
      tickSeq: (typeof state.tickSeq === 'number' ? state.tickSeq : 0) + 1,
      lastTickAt: new Date().toISOString(),
    };
    refreshed.stateDigest = soakStateDigest(process.env.CRON_SECRET, refreshed);
    await gh(`/repos/${repo}/issues/${issue.number}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ body: renderState(refreshed) }),
    });
    await gh(`/repos/${repo}/issues/${issue.number}/comments`, token, {
      method: 'POST',
      body: JSON.stringify({
        body: renderCheckpoint({
          tickSeq: refreshed.tickSeq,
          stateDigest: refreshed.stateDigest,
        }),
      }),
    });
    console.log(
      `soak: refreshed the observability proof on issue #${issue.number} ` +
        `(events ${seeded.serverEventId}, ${seeded.browserEventId}).`,
    );
    return;
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
      schemaVersion: SOAK_STATE_VERSION,
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
    // tickSeq 0 needs no checkpoint — verifyCheckpointChain() allows an empty
    // chain only at tick 0, which is exactly this moment and no other.
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
      // `verifiedAt` comes from the persisted, signed receipt — the verifier
      // wrote it, and the receipt digest covers it.
      sentry: { ...sentry, verifiedAt: state.sentry?.verifiedAt ?? null },
      outboxDead,
      unhealthyJobs,
      retentionSuccessAt,
    },
  });

  const nextState = {
    ...state,
    schemaVersion: SOAK_STATE_VERSION,
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
  // The checkpoint is posted AFTER the body is written, below, so a failure
  // between the two leaves a body without its checkpoint. The next tick sees a
  // state ahead of the chain tip and REFUSES.
  //
  // That refusal is new. This comment previously asserted it while
  // `verifyCheckpointChain` returned `ok: true` for exactly that case — the one
  // crash the write order was designed around was the one it did not catch.
  // Failing closed is the correct direction: a missing checkpoint must never be
  // indistinguishable from a deleted one, and from here they are not
  // distinguishable at all.

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
  // The checkpoint, immediately after the body it describes.
  await gh(`/repos/${repo}/issues/${issue.number}/comments`, token, {
    method: 'POST',
    body: JSON.stringify({
      body: renderCheckpoint({
        tickSeq: nextState.tickSeq,
        stateDigest: nextState.stateDigest,
      }),
    }),
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
