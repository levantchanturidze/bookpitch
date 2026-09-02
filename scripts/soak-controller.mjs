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
 *   state: {releaseSha: string, deploymentId: string, startedAt: string, restarts?: Array<{at: string, reason: string}>},
 *   evidence: {
 *     monitorRuns: Array<{runId: number, event: string, conclusion: string, completedAt: string}>,
 *     backupRuns: Array<{runId: number, event: string, conclusion: string, completedAt: string}>,
 *     cronRuns: Array<{runId: number, event: string, conclusion: string, completedAt: string}>,
 *     incidents: Array<{number: number, createdAt: string, state: string}>,
 *     deployment: {sha: string, id: string} | null,
 *     sentry: {configured: boolean, receiptVerified: boolean} | null,
 *     outboxDead: number | null,
 *   },
 *   now?: Date,
 *   opts?: typeof SOAK_DEFAULTS,
 * }} input
 */
export function evaluateSoak({ state, evidence, now = new Date(), opts = SOAK_DEFAULTS }) {
  const restarts = [...(state.restarts ?? [])];
  let windowStart = new Date(state.startedAt);

  const scheduled = (runs) => (runs ?? []).filter((r) => r.event === 'schedule');
  const after = (runs, from) => runs.filter((r) => new Date(r.completedAt) > from);

  // --- Restart conditions, applied before anything is measured -------------
  //
  // A soak is a claim about ONE deployment. If production has moved on, every
  // observation after that moment describes different code, and carrying them
  // forward would be the soak equivalent of counting manual dispatches.
  if (evidence.deployment && evidence.deployment.sha !== state.releaseSha) {
    return {
      status: 'superseded',
      windowStart: windowStart.toISOString(),
      elapsedHours: (now.getTime() - windowStart.getTime()) / HOUR,
      restarts,
      restartedThisTick: null,
      gates: [],
      observations: [],
      // Same shape as the running/success return. A caller should not have to
      // know which branch produced the result to read the evidence off it.
      evidenceIds: { monitorRuns: [], backupRuns: [], cronRuns: [] },
      summary:
        `production is now serving ${String(evidence.deployment.sha).slice(0, 7)}, not the soak's ` +
        `${String(state.releaseSha).slice(0, 7)}. A soak measures one deployment; this one is over. ` +
        'Start a new soak against the new SHA deliberately.',
    };
  }

  // The window resets to the moment of the most recent release-critical
  // failure. What must be uninterrupted is the healthy stretch — not the
  // elapsed clock, which is why "24 hours have passed" can never be the test.
  const failedObservations = after(scheduled(evidence.monitorRuns), windowStart).filter(
    (r) => r.conclusion === 'failure',
  );
  const newIncidents = (evidence.incidents ?? []).filter(
    (i) => new Date(i.createdAt) > windowStart && i.state === 'open',
  );

  const criticalMoments = [
    ...failedObservations.map((r) => ({
      at: r.completedAt,
      reason: `production monitor run ${r.runId} reported a failing check`,
    })),
    ...newIncidents.map((i) => ({
      at: i.createdAt,
      reason: `production incident #${i.number} opened and is still open`,
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  let restartedThisTick = null;
  if (criticalMoments.length > 0) {
    const last = criticalMoments[criticalMoments.length - 1];
    windowStart = new Date(last.at);
    restartedThisTick = last;
    restarts.push(last);
  }

  // --- Gates, all measured inside the (possibly reset) window ---------------
  const observations = after(scheduled(evidence.monitorRuns), windowStart);
  const cleanObservations = observations.filter((r) => r.conclusion === 'success');
  const backups = after(scheduled(evidence.backupRuns), windowStart).filter(
    (r) => r.conclusion === 'success',
  );
  const crons = after(scheduled(evidence.cronRuns), windowStart).filter(
    (r) => r.conclusion === 'success',
  );
  const elapsedHours = (now.getTime() - windowStart.getTime()) / HOUR;

  const gates = [
    {
      id: 'window-elapsed',
      ok: elapsedHours >= opts.windowHours,
      detail: `${elapsedHours.toFixed(1)}h of an uninterrupted ${opts.windowHours}h window`,
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
      // Deliberately not "the latest run was green". One failure anywhere in
      // the window already reset the window above; this is the assertion that
      // the reset actually happened.
      ok: observations.length === cleanObservations.length,
      detail: `${observations.length - cleanObservations.length} failing observations in the window`,
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
      id: 'no-open-incident',
      ok: newIncidents.length === 0,
      detail:
        newIncidents.length === 0
          ? 'no production incident opened during the window'
          : `open incident(s): ${newIncidents.map((i) => `#${i.number}`).join(', ')}`,
    },
    {
      id: 'outbox-clean',
      // null is not zero. A metric that could not be read is not evidence of
      // health — that conflation is what closed incident #26.
      ok: evidence.outboxDead === 0,
      detail:
        evidence.outboxDead === null || evidence.outboxDead === undefined
          ? 'outbox dead-letter count could not be read — not evidence of health'
          : `${evidence.outboxDead} dead-lettered outbox row(s)`,
    },
    {
      id: 'observability',
      ok: Boolean(evidence.sentry?.configured && evidence.sentry?.receiptVerified),
      detail: !evidence.sentry?.configured
        ? 'Sentry is not configured — uncaught exceptions in production are discarded, ' +
          'so an unobserved window proves nothing'
        : evidence.sentry?.receiptVerified
          ? 'Sentry configured and receipt verified'
          : 'Sentry is configured but receipt has not been verified',
    },
  ];

  const failing = gates.filter((g) => !g.ok);
  return {
    status: failing.length === 0 ? 'success' : restartedThisTick ? 'restarted' : 'running',
    windowStart: windowStart.toISOString(),
    elapsedHours,
    restarts,
    restartedThisTick,
    gates,
    observations: observations.map((r) => ({
      runId: r.runId,
      at: r.completedAt,
      conclusion: r.conclusion,
    })),
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

async function runsFor(repo, token, workflow, event, perPage = 40) {
  const data = await gh(
    `/repos/${repo}/actions/workflows/${workflow}/runs?branch=main&event=${event}&per_page=${perPage}`,
    token,
  );
  return (data.workflow_runs ?? [])
    .filter((r) => r.status === 'completed')
    .map((r) => ({
      runId: r.id,
      event: r.event,
      conclusion: r.conclusion,
      completedAt: r.updated_at,
    }));
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
  let issue = (issues ?? []).find((i) => (i.body ?? '').includes(SOAK_MARKER));
  let state = issue ? parseState(issue.body) : null;

  // Starting a soak is deliberate. A scheduled tick with no open soak issue
  // does nothing at all rather than inventing a start time — a soak that began
  // by accident is not evidence of anything.
  if (!state) {
    if (process.env.SOAK_START !== 'true') {
      console.log(
        'soak: no open soak issue; nothing to do (dispatch with SOAK_START=true to begin)',
      );
      return;
    }
    const sha = process.env.SOAK_RELEASE_SHA;
    if (!sha) {
      console.error('soak: SOAK_RELEASE_SHA is required to start a soak');
      process.exit(1);
    }
    state = {
      releaseSha: sha,
      deploymentId: process.env.SOAK_DEPLOYMENT_ID ?? 'unknown',
      startedAt: new Date().toISOString(),
      restarts: [],
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

  const [monitorRuns, backupRuns, cronRuns, incidents] = await Promise.all([
    runsFor(repo, token, 'production-monitor.yml', 'schedule'),
    runsFor(repo, token, 'production-backup.yml', 'schedule'),
    runsFor(repo, token, 'cron.yml', 'schedule'),
    gh(`/repos/${repo}/issues?state=all&labels=ops-incident&per_page=50`, token),
  ]);

  // Deployment identity and the two runtime facts, read from the deployed
  // application itself rather than assumed.
  let deployment = null;
  let sentry = { configured: false, receiptVerified: false };
  let outboxDead = null;
  try {
    const deployments = await gh(
      `/repos/${repo}/deployments?environment=Production&per_page=1`,
      token,
    );
    if (deployments?.[0]) deployment = { sha: deployments[0].sha, id: String(deployments[0].id) };
  } catch {
    /* leave null — a gate reads null as "not evidence of health" */
  }
  const cronSecret = process.env.CRON_SECRET;
  const target = process.env.MONITOR_PRODUCTION_URL ?? 'https://bookpitch.ge';
  if (cronSecret) {
    try {
      const res = await fetch(`${target}/api/health/ops`, {
        headers: { authorization: `Bearer ${cronSecret}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const m = await res.json();
        outboxDead = m?.metrics?.outbox?.dead ?? m?.outbox?.dead ?? null;
        const missing = m?.metrics?.config?.missingObservabilityEnv ?? null;
        sentry = {
          configured: missing === 0,
          // Receipt cannot be proven from a counter. It is set only by
          // scripts/verify-sentry.mjs reaching level 4 and recording it here.
          receiptVerified: process.env.SOAK_SENTRY_RECEIPT_VERIFIED === 'true' && missing === 0,
        };
      }
    } catch {
      /* leave null */
    }
  }

  const result = evaluateSoak({
    state,
    evidence: {
      monitorRuns,
      backupRuns,
      cronRuns,
      incidents: (incidents ?? []).map((i) => ({
        number: i.number,
        createdAt: i.created_at,
        state: i.state,
      })),
      deployment,
      sentry,
      outboxDead,
    },
  });

  const nextState = { ...state, restarts: result.restarts, lastTickAt: new Date().toISOString() };
  await gh(`/repos/${repo}/issues/${issue.number}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ body: renderState(nextState) }),
  });
  await gh(`/repos/${repo}/issues/${issue.number}/comments`, token, {
    method: 'POST',
    body: JSON.stringify({ body: renderReport(nextState, result) }),
  });

  console.log(renderReport(nextState, result));

  if (result.status === 'success' || result.status === 'superseded') {
    await gh(`/repos/${repo}/issues/${issue.number}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
  }
  // A tick that merely reports progress is a success for the WORKFLOW: the
  // controller did its job. Only a controller error should fail the run, or
  // the soak issue fills with red runs that mean "still waiting".
}

const isEntrypoint =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(`soak: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  });
}
