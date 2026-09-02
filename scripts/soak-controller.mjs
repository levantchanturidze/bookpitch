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
  /** Both canonical hosts must resolve to the deployment under soak. */
  requiredAliases: ['bookpitch.ge', 'www.bookpitch.ge'],
};

/** Marker so the state block is found by content, never by issue title. */
export const SOAK_MARKER = '<!-- bookpitch-soak-state -->';
export const SOAK_LABEL = 'soak';

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

const HOUR = 3_600_000;

/**
 * Decide where the soak stands.
 *
 * @param {{
 *   state: {releaseSha: string, deploymentId?: string|null, startedAt: string,
 *           effectiveWindowStart?: string, lastProcessedMonitorRun?: number|null,
 *           restarts?: Array<{at: string, reason: string}>},
 *   evidence: {
 *     monitorRuns: Array<{runId: number, event: string, conclusion: string, completedAt: string}>,
 *     backupRuns: Array<{runId: number, event: string, conclusion: string, completedAt: string}>,
 *     cronRuns: Array<{runId: number, event: string, conclusion: string, completedAt: string}>,
 *     incidents: Array<{number: number, createdAt: string, state: string}>,
 *     deployment: {sha: string, id: string, state?: string|null,
 *                  environment?: string|null, aliases?: string[]} | null,
 *     sentry: {configured: boolean, serverEventId: string|null, browserEventId: string|null,
 *              sourceMapsResolved: boolean} | null,
 *     outboxDead: number | null,
 *     jobsNotSucceeding?: number | null,
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

  const scheduled = (runs) => (runs ?? []).filter((r) => r.event === 'schedule');
  const after = (runs, from) => runs.filter((r) => new Date(r.completedAt) > from);

  const fail = (status, summary, extra = {}) => ({
    status,
    windowStart: windowStart.toISOString(),
    effectiveWindowStart: windowStart.toISOString(),
    elapsedHours: (now.getTime() - windowStart.getTime()) / 3_600_000,
    restarts,
    restartedThisTick: null,
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
  if (!evidence.deployment) {
    return fail(
      'blocked',
      'deployment evidence could not be read, so there is nothing to pin the soak to. ' +
        'A soak that cannot name the code it is measuring is not evidence.',
    );
  }

  const d = evidence.deployment;
  const identityProblems = [];
  if (d.sha !== state.releaseSha) {
    identityProblems.push(
      `production serves ${String(d.sha).slice(0, 7)}, not the soak's ${String(state.releaseSha).slice(0, 7)}`,
    );
  }
  if (state.deploymentId && d.id && String(d.id) !== String(state.deploymentId)) {
    identityProblems.push(`deployment is ${d.id}, not the pinned ${state.deploymentId}`);
  }
  if (d.state && d.state !== 'success' && d.state !== 'READY') {
    identityProblems.push(`deployment state is ${d.state}, not success/READY`);
  }
  if (d.environment && d.environment.toLowerCase() !== 'production') {
    identityProblems.push(`environment is ${d.environment}, not Production`);
  }
  // Both canonical hosts must resolve to this deployment. A soak on a
  // deployment that is live but not the one serving customers proves nothing.
  const aliases = (d.aliases ?? []).map((a) => String(a).toLowerCase());
  for (const required of opts.requiredAliases) {
    if (!aliases.some((a) => a === required || a === `https://${required}`)) {
      identityProblems.push(`alias ${required} does not resolve to this deployment`);
    }
  }
  if (identityProblems.length > 0) {
    return fail(
      'superseded',
      `the deployment under soak is not the one serving production: ${identityProblems.join('; ')}. ` +
        'A soak measures one deployment; start a new one against the new SHA deliberately.',
    );
  }

  // --- Restart conditions ---------------------------------------------------
  //
  // Incidents count if they were OPENED during the window, whether or not they
  // were subsequently closed. An incident that opened and auto-closed still
  // means production was unhealthy for part of the window, and the window is a
  // claim about an UNINTERRUPTED healthy stretch.
  const failedObservations = after(scheduled(evidence.monitorRuns), windowStart).filter(
    (r) => r.conclusion !== 'success',
  );
  const incidentsInWindow = (evidence.incidents ?? []).filter(
    (i) => new Date(i.createdAt) > windowStart,
  );
  const stillOpenIncidents = (evidence.incidents ?? []).filter((i) => i.state === 'open');

  const criticalMoments = [
    ...failedObservations.map((r) => ({
      at: r.completedAt,
      reason: `production monitor run ${r.runId} concluded ${String(r.conclusion).toUpperCase()}`,
    })),
    ...incidentsInWindow.map((i) => ({
      at: i.createdAt,
      reason: `production incident #${i.number} opened during the window (state now ${i.state})`,
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  let restartedThisTick = null;
  if (criticalMoments.length > 0) {
    const last = criticalMoments[criticalMoments.length - 1];
    if (new Date(last.at) > windowStart) {
      windowStart = new Date(last.at);
      restartedThisTick = last;
      restarts.push(last);
    }
  }

  // --- Gates ----------------------------------------------------------------
  const observations = after(scheduled(evidence.monitorRuns), windowStart);
  const cleanObservations = observations.filter((r) => r.conclusion === 'success');
  const backups = after(scheduled(evidence.backupRuns), windowStart).filter(
    (r) => r.conclusion === 'success',
  );
  const crons = after(scheduled(evidence.cronRuns), windowStart).filter(
    (r) => r.conclusion === 'success',
  );
  const elapsedHours = (now.getTime() - windowStart.getTime()) / 3_600_000;

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
      id: 'no-incident-in-window',
      ok: incidentsInWindow.length === 0 && stillOpenIncidents.length === 0,
      detail:
        incidentsInWindow.length === 0 && stillOpenIncidents.length === 0
          ? 'no incident opened during the window, and none open now'
          : [
              incidentsInWindow.length
                ? `opened during window: ${incidentsInWindow.map((i) => `#${i.number}`).join(', ')}`
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
      ok: evidence.jobsNotSucceeding === 0,
      detail:
        evidence.jobsNotSucceeding === null || evidence.jobsNotSucceeding === undefined
          ? 'cron outcome state could not be read — not evidence of health'
          : `${evidence.jobsNotSucceeding} scheduled job(s) whose last attempt did not succeed`,
    },
    {
      id: 'observability',
      // Receipt is a fact about Sentry's API, recorded with event ids. It is
      // NOT a boolean an operator can set: the previous version accepted
      // SOAK_SENTRY_RECEIPT_VERIFIED=true from the workflow input, which made
      // the gate a checkbox.
      ok: Boolean(
        evidence.sentry?.configured &&
        evidence.sentry?.serverEventId &&
        evidence.sentry?.browserEventId &&
        evidence.sentry?.sourceMapsResolved,
      ),
      detail: !evidence.sentry?.configured
        ? 'Sentry is not configured — uncaught exceptions in production are discarded, ' +
          'so an unobserved window proves nothing'
        : !evidence.sentry?.serverEventId || !evidence.sentry?.browserEventId
          ? 'Sentry receipt not verified: need BOTH a server and a browser event id ' +
            'confirmed visible through the Sentry API'
          : !evidence.sentry?.sourceMapsResolved
            ? 'Sentry has the events but production stack frames do not resolve through ' +
              'uploaded source maps'
            : `Sentry receipt verified (server ${evidence.sentry.serverEventId}, ` +
              `browser ${evidence.sentry.browserEventId}), source maps resolve`,
    },
  ];

  const failing = gates.filter((g) => !g.ok);
  return {
    status: failing.length === 0 ? 'success' : restartedThisTick ? 'restarted' : 'running',
    windowStart: windowStart.toISOString(),
    // Persisted verbatim by the caller so the next tick starts from here.
    effectiveWindowStart: windowStart.toISOString(),
    elapsedHours,
    restarts,
    restartedThisTick,
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

/** The comment posted on every tick. Public, so it must carry no secrets. */
export function renderReport(state, result) {
  const mark = (g) => (g.ok ? '✅' : '⏳');
  const lines = [
    result.status === 'success'
      ? '## FINAL SUCCESS — 24-hour soak complete'
      : result.status === 'superseded'
        ? '## Soak ended — the deployment it was measuring was replaced'
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
      runs.push({
        runId: r.id,
        event: r.event ?? event,
        conclusion: r.conclusion,
        completedAt: r.updated_at,
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
    // Filled in by the caller from the alias probe below.
    aliases: [],
  };
}

/**
 * Which canonical hosts actually serve the deployment under soak.
 *
 * Probed rather than assumed: a deployment can be READY, be the newest
 * Production record, and still not be what bookpitch.ge resolves to.
 */
async function resolveAliases(hosts, expectedSha) {
  const resolved = [];
  for (const host of hosts) {
    try {
      const res = await fetch(`https://${host}/api/health`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) resolved.push(host);
    } catch {
      /* unreachable host simply does not resolve; the gate reports it */
    }
  }
  return { resolved, expectedSha };
}

/**
 * Sentry receipt, verified against Sentry's own API.
 *
 * This replaces SOAK_SENTRY_RECEIPT_VERIFIED, a workflow boolean an operator
 * ticked. A checkbox is not evidence that an error would reach a human, and it
 * is exactly the kind of self-asserted signal the rest of this project exists
 * to remove.
 *
 * Requires the event ids recorded by scripts/verify-sentry.mjs and confirms
 * each is retrievable from the intended organization/project. Returns nulls
 * when the credentials are absent, which fails the gate.
 */
async function verifySentryReceipt(persisted) {
  const token = process.env.SENTRY_AUTH_TOKEN;
  const org = process.env.SENTRY_ORG;
  const project = process.env.SENTRY_PROJECT;
  const serverId = persisted?.serverEventId;
  const browserId = persisted?.browserEventId;
  if (!token || !org || !project || !serverId || !browserId) {
    return {
      configured: Boolean(persisted?.configured),
      serverEventId: null,
      browserEventId: null,
      sourceMapsResolved: false,
      reason: !token
        ? 'SENTRY_AUTH_TOKEN is not set'
        : !org || !project
          ? 'SENTRY_ORG / SENTRY_PROJECT are not set'
          : 'no verified event ids are persisted — run scripts/verify-sentry.mjs',
    };
  }
  const seen = {};
  for (const [key, id] of [
    ['serverEventId', serverId],
    ['browserEventId', browserId],
  ]) {
    try {
      const res = await fetch(`https://sentry.io/api/0/projects/${org}/${project}/events/${id}/`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      seen[key] = res.ok ? id : null;
    } catch {
      seen[key] = null;
    }
  }
  return {
    configured: true,
    serverEventId: seen.serverEventId ?? null,
    browserEventId: seen.browserEventId ?? null,
    sourceMapsResolved: Boolean(persisted?.sourceMapsResolved),
    reason: null,
  };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.error('soak: GITHUB_TOKEN and GITHUB_REPOSITORY are required');
    process.exit(1);
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
    const startedAt = new Date().toISOString();
    state = {
      releaseSha: sha,
      deploymentId: process.env.SOAK_DEPLOYMENT_ID ?? null,
      startedAt,
      effectiveWindowStart: startedAt,
      restarts: [],
      lastProcessedMonitorRun: null,
      sentry: {
        configured: false,
        serverEventId: null,
        browserEventId: null,
        sourceMapsResolved: false,
      },
      lastTickAt: null,
    };
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
    gh(`/repos/${repo}/issues?state=all&labels=ops-incident&per_page=100`, token),
  ]);

  let deployment = null;
  try {
    deployment = await currentDeployment(repo, token);
    if (deployment) {
      const { resolved } = await resolveAliases(SOAK_DEFAULTS.requiredAliases, deployment.sha);
      deployment.aliases = resolved;
    }
  } catch {
    /* null → the evaluator blocks, which is the point */
  }

  let outboxDead = null;
  let jobsNotSucceeding = null;
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
        jobsNotSucceeding = m?.cronHeartbeat?.jobsNotSucceeding ?? null;
        sentryConfigured = (m?.config?.missingObservabilityEnv ?? null) === 0;
      }
    } catch {
      /* null → gates read it as "not evidence of health" */
    }
  }

  const sentry = await verifySentryReceipt({
    ...(state.sentry ?? {}),
    configured: sentryConfigured,
  });

  const result = evaluateSoak({
    state,
    evidence: {
      monitorRuns: monitor.runs,
      backupRuns: backup.runs,
      cronRuns: cron.runs,
      historyComplete: monitor.complete && backup.complete && cron.complete,
      incidents: (incidents ?? []).map((i) => ({
        number: i.number,
        createdAt: i.created_at,
        state: i.state,
      })),
      deployment,
      sentry,
      outboxDead,
      jobsNotSucceeding,
    },
  });

  const nextState = {
    ...state,
    // The whole point: the restarted window is written down, so the next tick
    // starts from here even after the failing run ages out of history.
    effectiveWindowStart: result.effectiveWindowStart ?? windowStart,
    restarts: result.restarts,
    lastProcessedMonitorRun:
      result.lastProcessedMonitorRun ?? state.lastProcessedMonitorRun ?? null,
    sentry: {
      configured: sentry.configured,
      serverEventId: sentry.serverEventId,
      browserEventId: sentry.browserEventId,
      sourceMapsResolved: sentry.sourceMapsResolved,
      verifiedAt: sentry.serverEventId && sentry.browserEventId ? new Date().toISOString() : null,
    },
    lastTickAt: new Date().toISOString(),
  };

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
