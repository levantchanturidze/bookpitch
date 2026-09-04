#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Raise, update or resolve the observability incident from a verification run.
//
// The production monitor's `production-observability-unconfigured` check counts
// unset DSN variable NAMES. Zero means two strings exist — a revoked, mistyped,
// filtered, quota-exhausted or wrong-project DSN is indistinguishable from a
// working one. It is marked `canClose: false` for that reason, and something
// else has to be the authority.
//
// This is that authority, and it runs on a bounded schedule whether or not a
// soak is open — a production where error delivery has silently stopped must
// not look identical to one where it works just because nobody is soaking.
//
// Reuses the monitor's canonical-issue reconciliation, so the incident keeps
// its number and its history rather than accumulating duplicates.
// -----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { reconcileIncidents, incidentMarker, INCIDENT_LABEL } from './production-monitor.mjs';
import { shouldCloseObservabilityIncident } from './sentry-receipt.mjs';

const CHECK_ID = 'production-observability-unconfigured';
const TITLE = 'Application errors are not being reported anywhere';

async function gh(path, token, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'bookpitch-sentry-incident',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const outcomePath = process.env.SENTRY_OUTCOME_IN;
  if (!token || !repo || !outcomePath) {
    console.error(
      'sentry-incident: GITHUB_TOKEN, GITHUB_REPOSITORY and SENTRY_OUTCOME_IN required',
    );
    process.exit(1);
  }

  let outcome;
  try {
    outcome = JSON.parse(readFileSync(outcomePath, 'utf8'));
  } catch (err) {
    // No outcome file means the verifier did not get far enough to write one —
    // which is itself an unknown, not a pass.
    outcome = {
      state: 'indeterminate',
      summary:
        'The verification run produced no outcome document, so it failed before it could ' +
        'classify anything. Treated as unknown.',
      problems: [`${err instanceof Error ? err.message : 'unreadable'}`],
    };
  }

  const verified = shouldCloseObservabilityIncident(outcome);
  const result = {
    id: CHECK_ID,
    title: TITLE,
    ok: verified,
    detail: outcome.summary,
    // The one thing allowed to close this incident is a complete pass, which is
    // exactly what `verified` means here.
    canClose: true,
  };

  const open = await gh(
    `/repos/${repo}/issues?state=open&labels=${INCIDENT_LABEL}&per_page=100`,
    token,
  );
  const closed = await gh(
    `/repos/${repo}/issues?state=closed&labels=${INCIDENT_LABEL}&per_page=50&sort=created&direction=desc`,
    token,
  );
  const plan = reconcileIncidents([result], open ?? [], closed ?? []);

  const body = (lead) =>
    [
      incidentMarker(CHECK_ID),
      `**Incident class:** \`${CHECK_ID}\``,
      `**State:** \`${outcome.state}\``,
      '',
      lead,
      '',
      `**Detail:** ${outcome.summary}`,
      ...(outcome.problems?.length
        ? ['', '**Findings:**', ...outcome.problems.map((p) => `- ${p}`)]
        : []),
      '',
      `Verification run: ${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      '',
      '<sub>Raised by the end-to-end Sentry verifier. The production monitor can only see ' +
        'whether DSN variable names are set, which a revoked or mistyped DSN satisfies, so it ' +
        'cannot open or close this on its own.</sub>',
    ].join('\n');

  for (const { result: r } of plan.toOpen) {
    const issue = await gh(`/repos/${repo}/issues`, token, {
      method: 'POST',
      body: JSON.stringify({
        title: `[ops] ${r.title}`,
        body: body(`**First detected:** ${new Date().toISOString()}`),
        labels: [INCIDENT_LABEL],
      }),
    });
    console.log(`opened #${issue.number}`);
  }
  for (const { issue } of plan.toReopen) {
    await gh(`/repos/${repo}/issues/${issue.number}/comments`, token, {
      method: 'POST',
      body: JSON.stringify({ body: body('Reopened: still not verified.') }),
    });
    await gh(`/repos/${repo}/issues/${issue.number}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'open' }),
    });
    console.log(`reopened #${issue.number}`);
  }
  for (const { issue } of plan.toComment) {
    await gh(`/repos/${repo}/issues/${issue.number}/comments`, token, {
      method: 'POST',
      body: JSON.stringify({ body: body('Still not verified.') }),
    });
    console.log(`commented on #${issue.number}`);
  }
  for (const { issue, canonical } of plan.toCloseDuplicate) {
    await gh(`/repos/${repo}/issues/${issue.number}/comments`, token, {
      method: 'POST',
      body: JSON.stringify({
        body: `Closing as a duplicate of #${canonical.number}, which carries the full history.`,
      }),
    });
    await gh(`/repos/${repo}/issues/${issue.number}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }),
    });
    console.log(`closed duplicate #${issue.number}`);
  }
  for (const { issue } of plan.toClose) {
    await gh(`/repos/${repo}/issues/${issue.number}/comments`, token, {
      method: 'POST',
      body: JSON.stringify({ body: body('Resolved by end-to-end verification.') }),
    });
    await gh(`/repos/${repo}/issues/${issue.number}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    });
    console.log(`closed #${issue.number} by evidence`);
  }

  // The exit code reports the OUTCOME, not whether the bookkeeping worked. A
  // green run here would say "error reporting is fine" on a state of unknown.
  if (!verified) {
    console.error(`\nSentry is ${outcome.state}: ${outcome.summary}`);
    process.exit(1);
  }
  console.log('\nSentry verified end to end.');
}

main().catch((err) => {
  console.error(`sentry-incident: ${err instanceof Error ? err.message : 'unknown'}`);
  process.exit(1);
});
