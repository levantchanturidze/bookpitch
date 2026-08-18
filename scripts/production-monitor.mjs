#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Production monitor for bookpitch.ge.
//
// Run by .github/workflows/production-monitor.yml every 30 minutes. Deliberately
// dependency-free (Node built-ins only) so the workflow never has to run
// `npm ci` — a monitor that takes a minute to install packages before it can
// tell you the site is down is not a monitor.
//
// Design notes worth keeping:
//
//  * Every check returns a structured result. Nothing throws its way out of a
//    check: a check that blows up becomes a failing check, so one broken probe
//    cannot hide the other eleven.
//  * Alerting runs after all checks and its own failure is reported separately
//    and still fails the run. An alerting bug must never look like health.
//  * Nothing that touches production data is fetched. The ops endpoint returns
//    counts and ages; this script never asks for anything else.
//
// The pure evaluation functions are exported and unit-tested in
// tests/production-monitor.test.ts — the network wrapper is the only untested
// part, and it is kept trivial for that reason.
// -----------------------------------------------------------------------------

import tls from 'node:tls';
import process from 'node:process';

export const DEFAULTS = {
  productionUrl: 'https://bookpitch.ge',
  /** Daily backup at 01:40 UTC; 26h allows one late run before alerting. */
  backupMaxAgeHours: 26,
  /** Monthly drill on the 4th; 40 days tolerates one skipped month boundary. */
  restoreDrillMaxAgeDays: 40,
  /** Reminders run every 15 minutes, so a 90-minute gap means something broke. */
  cronMaxAgeMinutes: 90,
  /** How many recent cron runs to consider when looking for repeated failure. */
  cronRecentRuns: 10,
  /** Repeated failures within that window that constitute an incident. */
  cronFailureThreshold: 3,
  /** Consecutive health probes; more than one 5xx across them is an incident. */
  healthProbeCount: 3,
  /** Alert when the TLS certificate expires sooner than this. */
  tlsMinDaysRemaining: 14,
  /** Outbox rows stuck pending longer than this suggest a dead drain loop. */
  outboxOldestPendingMaxSeconds: 3 * 3600,
  /** Weekly digest; alert if nothing has been queued for this long. */
  auditDigestMaxAgeHours: 24 * 10,
};

// -----------------------------------------------------------------------------
// Pure evaluation — no IO. Each returns { id, title, ok, detail }.
// -----------------------------------------------------------------------------

/** The public health endpoint must return exactly {"ok":true} and nothing else. */
export function evaluateHealthBody(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, reason: 'response body is not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'response body is not a JSON object' };
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'ok' || parsed.ok !== true) {
    // Report the KEY NAMES only. A health endpoint that started leaking build
    // info or env names must not have that leak copied into a public CI log.
    return { ok: false, reason: `expected exactly {"ok":true}, got keys [${keys.join(', ')}]` };
  }
  return { ok: true };
}

export function evaluateHealthProbes(probes, opts = DEFAULTS) {
  const failures = probes.filter((p) => !p.ok);
  const serverErrors = probes.filter((p) => p.status >= 500);
  const redirects = probes.filter((p) => p.status >= 300 && p.status < 400);

  const results = [];

  results.push({
    id: 'health-endpoint',
    title: 'Production health endpoint is failing',
    ok: failures.length === 0,
    detail:
      failures.length === 0
        ? `${probes.length}/${probes.length} probes returned 200 {"ok":true}`
        : failures
            .map((f) => `probe ${f.index}: status ${f.status}${f.reason ? ` — ${f.reason}` : ''}`)
            .join('; '),
  });

  results.push({
    id: 'production-5xx',
    title: 'Production is returning 5xx responses',
    // One transient 5xx is noise; two out of three is an outage.
    ok: serverErrors.length < 2,
    detail:
      serverErrors.length < 2
        ? `${serverErrors.length}/${probes.length} probes returned 5xx`
        : `${serverErrors.length}/${probes.length} probes returned 5xx (statuses: ${serverErrors
            .map((p) => p.status)
            .join(', ')})`,
  });

  results.push({
    id: 'unexpected-redirect',
    title: 'Production health endpoint is redirecting',
    ok: redirects.length === 0,
    detail:
      redirects.length === 0
        ? 'no redirects on the canonical health URL'
        : `${redirects.length} probe(s) redirected: ${redirects
            .map((p) => `${p.status} → ${p.location ?? 'unknown'}`)
            .join('; ')}`,
  });

  return results;
}

export function evaluateTls(cert, now = new Date(), opts = DEFAULTS) {
  if (!cert || !cert.valid_to) {
    return {
      id: 'tls',
      title: 'Production TLS certificate could not be read',
      ok: false,
      detail: 'TLS handshake produced no peer certificate',
    };
  }
  const expiry = new Date(cert.valid_to);
  const daysRemaining = Math.floor((expiry.getTime() - now.getTime()) / 86_400_000);
  return {
    id: 'tls',
    title: 'Production TLS certificate is expiring or invalid',
    ok: daysRemaining >= opts.tlsMinDaysRemaining,
    detail: `certificate valid until ${expiry.toISOString().slice(0, 10)} (${daysRemaining} days remaining)`,
  };
}

export function evaluateWorkflowFreshness({ id, title, label, latestSuccess, maxAgeMs, now }) {
  if (!latestSuccess) {
    return {
      id,
      title,
      ok: false,
      detail: `${label}: no successful run found at all`,
    };
  }
  const ageMs = now.getTime() - new Date(latestSuccess.completedAt).getTime();
  const ageHours = (ageMs / 3_600_000).toFixed(1);
  return {
    id,
    title,
    ok: ageMs <= maxAgeMs,
    detail: `${label}: last success ${ageHours}h ago (run ${latestSuccess.runId}), limit ${(
      maxAgeMs / 3_600_000
    ).toFixed(1)}h`,
  };
}

export function evaluateCronHealth(runs, now = new Date(), opts = DEFAULTS) {
  const results = [];

  const completed = runs.filter((r) => r.status === 'completed');
  const latestSuccess = completed.find((r) => r.conclusion === 'success');

  results.push(
    evaluateWorkflowFreshness({
      id: 'cron-staleness',
      title: 'Scheduled cron workflow has stopped running',
      label: 'Scheduled crons',
      latestSuccess: latestSuccess
        ? { completedAt: latestSuccess.completedAt, runId: latestSuccess.runId }
        : null,
      maxAgeMs: opts.cronMaxAgeMinutes * 60_000,
      now,
    }),
  );

  const recent = completed.slice(0, opts.cronRecentRuns);
  const failed = recent.filter((r) => r.conclusion === 'failure');
  results.push({
    id: 'cron-failures',
    title: 'Scheduled cron workflow is failing repeatedly',
    ok: failed.length < opts.cronFailureThreshold,
    detail:
      failed.length < opts.cronFailureThreshold
        ? `${failed.length}/${recent.length} recent cron runs failed`
        : `${failed.length}/${recent.length} recent cron runs failed (latest failing run ${failed[0].runId})`,
  });

  return results;
}

/**
 * Weekly audit digest freshness.
 *
 * P15-003: the previous version treated `hoursSinceLastQueued === null` as
 * healthy unconditionally, so a digest job that never ran once — which is
 * exactly what happens when GitHub silently drops a low-frequency cron
 * schedule, observed for `0 8 * * 1` on Monday 2026-08-17 — reported PASS
 * forever. "Never queued" is only benign while there is nothing to digest.
 *
 * The second input makes it falsifiable: `oldestEligibleOrgAgeHours` is the age
 * of the oldest organization that actually has an emailable owner. Once that
 * exceeds the digest window, a digest was genuinely due, and never having
 * queued one is an incident rather than a young-deployment artefact.
 */
export function evaluateAuditDigest({
  hoursSinceLastQueued,
  oldestEligibleOrgAgeHours,
  maxAgeHours,
}) {
  const id = 'audit-digest-stalled';
  const title = 'Weekly audit digest has stopped queueing mail';
  const age = hoursSinceLastQueued ?? null;
  const eligibleAge = oldestEligibleOrgAgeHours ?? null;

  if (age !== null) {
    return {
      id,
      title,
      ok: age <= maxAgeHours,
      detail: `last queued ${age.toFixed(1)}h ago (limit ${maxAgeHours}h)`,
    };
  }

  if (eligibleAge === null) {
    return {
      id,
      title,
      ok: true,
      detail: 'no digest queued yet, and no organization has an emailable owner',
    };
  }

  if (eligibleAge > maxAgeHours) {
    return {
      id,
      title,
      ok: false,
      detail:
        `no audit digest has EVER been queued, but an eligible organization has ` +
        `existed for ${eligibleAge.toFixed(1)}h (limit ${maxAgeHours}h) — the weekly ` +
        `job has never run. Check that the '0 8 * * 1' schedule in ` +
        `.github/workflows/cron.yml is still being delivered.`,
    };
  }

  return {
    id,
    title,
    ok: true,
    detail:
      `no digest queued yet; oldest eligible organization is ${eligibleAge.toFixed(1)}h old ` +
      `(within the ${maxAgeHours}h window)`,
  };
}

export function evaluateOpsMetrics(metrics, opts = DEFAULTS) {
  const results = [];
  const outbox = metrics?.outbox ?? {};
  const housekeeping = metrics?.housekeeping ?? {};
  const retention = metrics?.retention ?? {};
  const partitions = metrics?.partitions ?? {};
  const digest = metrics?.auditDigest ?? {};

  results.push({
    id: 'outbox-dead-letters',
    title: 'Email outbox has dead-lettered messages',
    ok: (outbox.dead ?? 0) === 0,
    detail: `dead=${outbox.dead ?? 0} (last 24h: ${outbox.deadLast24h ?? 0}, retry-exhausted: ${
      outbox.deadWithExhaustedRetries ?? 0
    })`,
  });

  results.push({
    id: 'outbox-stale-claims',
    title: 'Email outbox has stale processing claims',
    ok: (outbox.staleClaims ?? 0) === 0,
    detail: `staleClaims=${outbox.staleClaims ?? 0}, processing=${outbox.processing ?? 0}`,
  });

  const oldest = outbox.oldestPendingAgeSeconds;
  results.push({
    id: 'outbox-backlog',
    title: 'Email outbox is not draining',
    ok: oldest === null || oldest === undefined || oldest <= opts.outboxOldestPendingMaxSeconds,
    detail:
      oldest === null || oldest === undefined
        ? `pending=${outbox.pending ?? 0}, queue empty`
        : `pending=${outbox.pending ?? 0}, oldest pending ${Math.round(oldest / 60)} min (limit ${Math.round(
            opts.outboxOldestPendingMaxSeconds / 60,
          )} min)`,
  });

  const hkOverdue =
    (housekeeping.overdueRateLimitRows ?? 0) +
    (housekeeping.overdueExpiredTokens ?? 0) +
    (housekeeping.overdueReauthGrants ?? 0);
  results.push({
    id: 'housekeeping-stalled',
    title: 'Housekeeping job has stopped pruning',
    ok: hkOverdue === 0,
    detail: `overdue rows — rateLimit=${housekeeping.overdueRateLimitRows ?? 0}, tokens=${
      housekeeping.overdueExpiredTokens ?? 0
    }, reauthGrants=${housekeeping.overdueReauthGrants ?? 0}`,
  });

  results.push({
    id: 'retention-stalled',
    title: 'Customer retention job has stopped anonymising',
    ok: (retention.overdueCustomers ?? 0) === 0,
    detail: `customers past their retention window still holding PII: ${
      retention.overdueCustomers ?? 0
    }`,
  });

  results.push(
    evaluateAuditDigest({
      hoursSinceLastQueued: digest.hoursSinceLastQueued,
      oldestEligibleOrgAgeHours: digest.oldestEligibleOrgAgeHours,
      maxAgeHours: opts.auditDigestMaxAgeHours,
    }),
  );

  results.push({
    id: 'partition-maintenance',
    title: 'audit_log partition maintenance is behind',
    ok: (partitions.monthsAhead ?? 0) >= 1 && (partitions.defaultPartitionRows ?? 0) === 0,
    detail: `future monthly partitions=${partitions.monthsAhead ?? 0}, rows in audit_log_default=${
      partitions.defaultPartitionRows ?? 0
    }`,
  });

  // Phase 13: production signup was silently dead for a week because two
  // Turnstile binding variables were never set in Vercel. verifyTurnstile()
  // fails closed on a missing one, so every signup returned 400 and nothing
  // said so out loud. This check is the thing that would have caught it.
  const config = metrics?.config ?? {};
  const missing =
    (config.missingSignupEnv ?? 0) +
    (config.missingEmailEnv ?? 0) +
    (config.missingSecurityEnv ?? 0);
  results.push({
    id: 'production-config-incomplete',
    title: 'Production is missing required environment configuration',
    ok: missing === 0,
    detail: `missing required env vars — signup=${config.missingSignupEnv ?? 0}, email=${
      config.missingEmailEnv ?? 0
    }, security=${config.missingSecurityEnv ?? 0} (names in docs/operations.md § Required production environment)`,
  });

  // P15-010. The check above counts variables that are UNSET. Production had
  // FIELD_ENCRYPTION_KEY set without its "<key-id>:" prefix, so that count was
  // 0 and the configuration looked complete — while every encryptField() call
  // threw, breaking signup, patient clinical fields and MFA enrolment. None of
  // those paths had ever run in production, so nothing surfaced it for weeks.
  // Presence is not validity; this is the difference.
  const invalidConfig = (metrics?.config ?? {}).invalidSecurityEnv;
  results.push({
    id: 'production-config-invalid',
    title: 'A required secret is set but structurally unusable',
    ok: (invalidConfig ?? 0) === 0,
    detail:
      invalidConfig === undefined
        ? 'deployment predates the invalid-env metric — redeploy to enable this check'
        : `security env vars set but malformed: ${invalidConfig} ` +
          `(validators in lib/ops-metrics.ts SECURITY_ENV_VALIDATORS; names never leave the server)`,
  });

  return results;
}

// -----------------------------------------------------------------------------
// Incident reconciliation — pure. Given the check results and the currently
// open incident issues, decide what to open, comment on, and close.
// -----------------------------------------------------------------------------

export const INCIDENT_LABEL = 'ops-incident';

/** Stable, greppable marker so an incident issue is matched by body, not title. */
/**
 * Who to assign an incident to.
 *
 * P15-011: defaults to the repository owner derived from GITHUB_REPOSITORY,
 * overridable with INCIDENT_ASSIGNEES (comma-separated) if a rota ever exists.
 * Returns [] when it cannot be determined, so a missing value degrades to the
 * previous unassigned behaviour rather than failing the alert — an alert that
 * throws is strictly worse than one that is merely quiet.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function incidentAssignees(
  env = /** @type {Record<string, string | undefined>} */ (process.env),
) {
  const explicit = (env.INCIDENT_ASSIGNEES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  const owner = (env.GITHUB_REPOSITORY ?? '').split('/')[0]?.trim();
  return owner ? [owner] : [];
}

export function incidentMarker(id) {
  return `<!-- bookpitch-ops-incident:${id} -->`;
}

export function reconcileIncidents(results, openIssues) {
  const byId = new Map();
  for (const issue of openIssues) {
    const match = /<!-- bookpitch-ops-incident:([a-z0-9-]+) -->/.exec(issue.body ?? '');
    if (match) byId.set(match[1], issue);
  }

  const toOpen = [];
  const toComment = [];
  const toClose = [];

  const reportedIds = new Set(results.map((r) => r.id));

  for (const result of results) {
    const existing = byId.get(result.id);
    if (!result.ok) {
      if (existing) toComment.push({ result, issue: existing });
      else toOpen.push({ result });
    } else if (existing) {
      toClose.push({ result, issue: existing });
    }
  }

  // An open incident for a check that is no longer reported at all cannot still
  // be true — the check that raised it does not exist any more. Close it, with
  // its own reason so the comment does not claim a recovery that was never
  // observed. Found by the alert-path test: the synthetic `simulated-failure`
  // check only exists while MONITOR_SIMULATE_FAILURE is set, so its issue was
  // never in `results` on the next healthy run and stayed open forever. The
  // same would happen to any real check that is renamed or removed.
  for (const [id, issue] of byId) {
    if (reportedIds.has(id)) continue;
    toClose.push({
      result: {
        id,
        title: issue.title ?? id,
        ok: true,
        detail: 'this check is no longer reported by the monitor',
      },
      issue,
      orphaned: true,
    });
  }

  return { toOpen, toComment, toClose };
}

// -----------------------------------------------------------------------------
// IO layer.
// -----------------------------------------------------------------------------

async function probeHealth(url, count) {
  const probes = [];
  for (let index = 1; index <= count; index++) {
    try {
      const res = await fetch(`${url}/api/health`, {
        redirect: 'manual',
        headers: { 'user-agent': 'bookpitch-production-monitor' },
        signal: AbortSignal.timeout(15_000),
      });
      const status = res.status;
      const location = res.headers.get('location');
      if (status !== 200) {
        probes.push({ index, ok: false, status, location, reason: 'non-200 status' });
      } else {
        const body = await res.text();
        const verdict = evaluateHealthBody(body);
        probes.push({ index, ok: verdict.ok, status, location, reason: verdict.reason });
      }
    } catch (err) {
      probes.push({
        index,
        ok: false,
        status: 0,
        reason: `request failed: ${err instanceof Error ? err.name : 'unknown'}`,
      });
    }
    if (index < count) await new Promise((r) => setTimeout(r, 1500));
  }
  return probes;
}

function readCertificate(hostname) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port: 443, servername: hostname, timeout: 15_000 },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        socket.end();
        resolve(authorized ? cert : null);
      },
    );
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

async function gh(path, token, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'bookpitch-production-monitor',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `GitHub API ${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 200)}`,
    );
  }
  return res.status === 204 ? null : res.json();
}

async function latestSuccessfulRun(repo, token, workflowFile) {
  const data = await gh(
    `/repos/${repo}/actions/workflows/${workflowFile}/runs?status=success&branch=main&per_page=1`,
    token,
  );
  const run = data.workflow_runs?.[0];
  if (!run) return null;
  return { completedAt: run.updated_at, runId: run.id };
}

function check(id, title, ok, detail) {
  return { id, title, ok, detail };
}

async function main() {
  const productionUrl = process.env.MONITOR_PRODUCTION_URL || DEFAULTS.productionUrl;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const cronSecret = process.env.CRON_SECRET;
  const now = new Date();
  const results = [];

  // Deliberate failure injection for the alert-path test. Never affects
  // production: it only forces this monitor's own verdict to red so the
  // issue-open / issue-close path can be exercised end to end.
  const simulate = process.env.MONITOR_SIMULATE_FAILURE;

  // --- 1-3, 5-6. Health endpoint, exact body, redirects, repeated 5xx -------
  const probes = await probeHealth(productionUrl, DEFAULTS.healthProbeCount);
  results.push(...evaluateHealthProbes(probes));

  // --- 4. TLS -------------------------------------------------------------
  const hostname = new URL(productionUrl).hostname;
  results.push(evaluateTls(await readCertificate(hostname), now));

  // --- 7. Current production deployment is reachable ----------------------
  if (repo && token) {
    try {
      const deployments = await gh(
        `/repos/${repo}/deployments?environment=Production&per_page=1`,
        token,
      );
      const deployment = deployments?.[0];
      if (!deployment) {
        results.push(
          check(
            'deployment-reachable',
            'Production deployment could not be identified',
            false,
            'no Production deployment record found',
          ),
        );
      } else {
        const statuses = await gh(
          `/repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`,
          token,
        );
        const targetUrl = statuses?.[0]?.environment_url;
        if (!targetUrl) {
          results.push(
            check(
              'deployment-reachable',
              'Production deployment could not be identified',
              false,
              `deployment ${deployment.id} has no environment_url`,
            ),
          );
        } else {
          const res = await fetch(`${targetUrl}/api/health`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(15_000),
          });
          results.push(
            check(
              'deployment-reachable',
              'Current production deployment is not reachable',
              res.status === 200,
              `deployment ${String(deployment.sha).slice(0, 7)} responded ${res.status}`,
            ),
          );
        }
      }
    } catch (err) {
      results.push(
        check(
          'deployment-reachable',
          'Current production deployment is not reachable',
          false,
          `check failed: ${err instanceof Error ? err.message : 'unknown'}`,
        ),
      );
    }

    // --- 8. Cron workflow outcomes ---------------------------------------
    try {
      const data = await gh(
        `/repos/${repo}/actions/workflows/cron.yml/runs?branch=main&per_page=20`,
        token,
      );
      const runs = (data.workflow_runs ?? []).map((r) => ({
        runId: r.id,
        status: r.status,
        conclusion: r.conclusion,
        completedAt: r.updated_at,
      }));
      results.push(...evaluateCronHealth(runs, now));
    } catch (err) {
      results.push(
        check(
          'cron-staleness',
          'Scheduled cron workflow has stopped running',
          false,
          `check failed: ${err instanceof Error ? err.message : 'unknown'}`,
        ),
      );
    }

    // --- 9. Backup freshness ---------------------------------------------
    try {
      results.push(
        evaluateWorkflowFreshness({
          id: 'backup-freshness',
          title: 'Production backup has not run within its window',
          label: 'Production backup',
          latestSuccess: await latestSuccessfulRun(repo, token, 'production-backup.yml'),
          maxAgeMs: DEFAULTS.backupMaxAgeHours * 3_600_000,
          now,
        }),
      );
    } catch (err) {
      results.push(
        check(
          'backup-freshness',
          'Production backup has not run within its window',
          false,
          `check failed: ${err instanceof Error ? err.message : 'unknown'}`,
        ),
      );
    }

    // --- 10. Restore drill staleness -------------------------------------
    try {
      results.push(
        evaluateWorkflowFreshness({
          id: 'restore-drill-stale',
          title: 'Restore drill is stale — backups are not proven recoverable',
          label: 'Restore drill',
          latestSuccess: await latestSuccessfulRun(repo, token, 'restore-drill.yml'),
          maxAgeMs: DEFAULTS.restoreDrillMaxAgeDays * 86_400_000,
          now,
        }),
      );
    } catch (err) {
      results.push(
        check(
          'restore-drill-stale',
          'Restore drill is stale — backups are not proven recoverable',
          false,
          `check failed: ${err instanceof Error ? err.message : 'unknown'}`,
        ),
      );
    }
  } else {
    results.push(
      check(
        'github-api',
        'Monitor could not reach the GitHub API',
        false,
        'GITHUB_REPOSITORY or GITHUB_TOKEN is not set',
      ),
    );
  }

  // --- 11. Sanitized operational metrics ----------------------------------
  if (cronSecret) {
    try {
      const res = await fetch(`${productionUrl}/api/health/ops`, {
        headers: { authorization: `Bearer ${cronSecret}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        results.push(
          check(
            'ops-metrics',
            'Operational metrics endpoint is failing',
            false,
            `/api/health/ops returned ${res.status}`,
          ),
        );
      } else {
        const payload = await res.json();
        // P15-010/P15-004: surface the two counts an operator needs BEFORE
        // acting, rather than after. `ciphertext` answers "would correcting
        // FIELD_ENCRYPTION_KEY put existing encrypted data at risk?" and
        // `recipients` answers "how many real mailboxes does the next digest
        // reach?". Both are counts; assertMetricsAreNumericOnly guarantees no
        // address or identifier can travel this path into a CI log.
        const ct = payload?.metrics?.ciphertext ?? {};
        const dg = payload?.metrics?.auditDigest ?? {};
        const inventory =
          `ciphertext rows — customers=${ct.customerFields ?? '?'}, ` +
          `outbox=${ct.outboxRows ?? '?'}, mfa=${ct.mfaSecrets ?? '?'}, ` +
          `total=${ct.total ?? '?'}; digest recipients=${dg.eligibleRecipients ?? '?'}`;
        results.push(
          check(
            'ops-metrics',
            'Operational metrics endpoint is failing',
            true,
            `/api/health/ops returned 200 — ${inventory}`,
          ),
        );
        results.push(...evaluateOpsMetrics(payload.metrics));
      }
    } catch (err) {
      results.push(
        check(
          'ops-metrics',
          'Operational metrics endpoint is failing',
          false,
          `request failed: ${err instanceof Error ? err.name : 'unknown'}`,
        ),
      );
    }
  } else {
    results.push(
      check(
        'ops-metrics',
        'Operational metrics endpoint is failing',
        false,
        'CRON_SECRET is not configured for the monitor',
      ),
    );
  }

  if (simulate) {
    results.push(
      check(
        'simulated-failure',
        'Monitor alert-path test (synthetic, not a real incident)',
        false,
        `Deliberate failure injected by MONITOR_SIMULATE_FAILURE=${simulate} to exercise the alerting path. Production is unaffected.`,
      ),
    );
  }

  // --- Report -------------------------------------------------------------
  const failing = results.filter((r) => !r.ok);
  console.log('=== bookpitch production monitor ===');
  console.log(`time: ${now.toISOString()}`);
  console.log(`target: ${productionUrl}`);
  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(24)} ${r.detail}`);
  }
  console.log('');
  console.log(`${results.length - failing.length}/${results.length} checks passed`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    const lines = [
      `## Production monitor — ${failing.length === 0 ? '✅ healthy' : `❌ ${failing.length} failing`}`,
      '',
      `\`${now.toISOString()}\` · target \`${productionUrl}\``,
      '',
      '| | check | detail |',
      '| --- | --- | --- |',
      ...results.map((r) => `| ${r.ok ? '✅' : '❌'} | \`${r.id}\` | ${r.detail} |`),
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }

  // --- Alerting -----------------------------------------------------------
  // Runs last, and its failure is reported as its own line so it can never be
  // mistaken for "everything is fine".
  let alertingFailed = false;
  if (repo && token && process.env.MONITOR_ALERTS !== 'off') {
    try {
      await syncIncidents(repo, token, results, now);
    } catch (err) {
      alertingFailed = true;
      console.error(`ALERTING FAILED: ${err instanceof Error ? err.message : 'unknown'}`);
      console.error('The check results above are still authoritative.');
    }
  }

  if (failing.length > 0) {
    console.error(`\n${failing.length} production check(s) failing:`);
    for (const f of failing) console.error(`  - ${f.id}: ${f.detail}`);
    process.exit(1);
  }
  if (alertingFailed) process.exit(2);
  console.log('\nAll production checks passed.');
}

async function ensureLabel(repo, token) {
  try {
    await gh(`/repos/${repo}/labels/${INCIDENT_LABEL}`, token);
  } catch {
    await gh(`/repos/${repo}/labels`, token, {
      method: 'POST',
      body: JSON.stringify({
        name: INCIDENT_LABEL,
        color: 'b60205',
        description: 'Automated production monitor incident',
      }),
    });
  }
}

async function syncIncidents(repo, token, results, now) {
  await ensureLabel(repo, token);

  const openIssues = await gh(
    `/repos/${repo}/issues?state=open&labels=${INCIDENT_LABEL}&per_page=100`,
    token,
  );
  const { toOpen, toComment, toClose } = reconcileIncidents(results, openIssues ?? []);

  for (const { result } of toOpen) {
    const body = [
      incidentMarker(result.id),
      `**Incident class:** \`${result.id}\``,
      `**First detected:** ${now.toISOString()}`,
      '',
      `**Detail:** ${result.detail}`,
      '',
      'Opened automatically by `.github/workflows/production-monitor.yml`.',
      'This issue is deduplicated: repeated failures add a comment here rather than',
      'opening a new issue, and it is closed automatically when the check recovers.',
      '',
      'See `docs/operations.md` § Monitoring and alert handling for the runbook.',
    ].join('\n');
    // P15-011: assign the repository owner. A labelled issue alone produces no
    // notification — GitHub pushes to a user's inbox, email and mobile app for
    // @mentions and assignments, not for issue creation. .github/workflows/
    // migrate.yml learned this the hard way in SEC-007 (an incident sat
    // unnoticed until someone read it out of a report); the production
    // monitor, which is the primary alerting path and runs every 30 minutes,
    // had the same gap. With a single operator and no second responder, an
    // alert nobody is pinged about is not an alert.
    const issue = await gh(`/repos/${repo}/issues`, token, {
      method: 'POST',
      body: JSON.stringify({
        title: `[ops] ${result.title}`,
        body,
        labels: [INCIDENT_LABEL],
        ...(incidentAssignees().length ? { assignees: incidentAssignees() } : {}),
      }),
    });
    console.log(`alert: opened incident #${issue.number} for ${result.id}`);
  }

  for (const { result, issue } of toComment) {
    // One comment per run would spam a long outage. Only comment when the
    // detail line has changed since the last update, so an unchanging outage
    // stays a single quiet issue.
    const comments = await gh(`/repos/${repo}/issues/${issue.number}/comments?per_page=100`, token);
    const last = (comments ?? []).at(-1);
    const lastDetail = last?.body?.includes(result.detail);
    if (lastDetail) {
      console.log(`alert: incident #${issue.number} (${result.id}) unchanged — no new comment`);
      continue;
    }
    await gh(`/repos/${repo}/issues/${issue.number}/comments`, token, {
      method: 'POST',
      body: JSON.stringify({
        body: `Still failing at ${now.toISOString()}.\n\n**Detail:** ${result.detail}`,
      }),
    });
    // Re-assign alongside the comment so a snoozed or dismissed notification
    // pings again on a still-failing incident. Idempotent: assigning an
    // already-assigned user is a no-op.
    if (incidentAssignees().length) {
      await gh(`/repos/${repo}/issues/${issue.number}/assignees`, token, {
        method: 'POST',
        body: JSON.stringify({ assignees: incidentAssignees() }),
      }).catch(() => null);
    }
    console.log(`alert: updated incident #${issue.number} for ${result.id}`);
  }

  for (const { result, issue, orphaned } of toClose) {
    // Two different closings, said honestly. A recovery means the check ran and
    // passed. An orphan means the check is gone — claiming "recovered" there
    // would be a small lie in the audit trail.
    const body = orphaned
      ? `Closed at ${now.toISOString()} because ${result.detail}.\n\nThe check that opened this incident is no longer part of the monitor, so its state can no longer be observed. If the underlying condition still matters, re-add a check for it.`
      : `Recovered at ${now.toISOString()}.\n\n**Detail:** ${result.detail}\n\nClosing automatically.`;
    await gh(`/repos/${repo}/issues/${issue.number}/comments`, token, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    await gh(`/repos/${repo}/issues/${issue.number}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    });
    console.log(
      `alert: closed ${orphaned ? 'orphaned' : 'recovered'} incident #${issue.number} for ${result.id}`,
    );
  }
}

// Only run when invoked directly, so tests can import the pure functions.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`monitor crashed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(3);
  });
}
