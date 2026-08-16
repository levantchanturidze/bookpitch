import { describe, it, expect } from 'vitest';
import {
  DEFAULTS,
  evaluateHealthBody,
  evaluateHealthProbes,
  evaluateTls,
  evaluateWorkflowFreshness,
  evaluateCronHealth,
  evaluateOpsMetrics,
  reconcileIncidents,
  incidentMarker,
  INCIDENT_LABEL,
} from '../scripts/production-monitor.mjs';

// -----------------------------------------------------------------------------
// Phase 13 — the monitor's judgement, tested without touching the network.
//
// Every check below is tested in BOTH directions. A monitor that only has
// happy-path tests is the thing it is supposed to protect against: it would go
// green forever while production burned. So for each check there is a case that
// makes it fail, and the assertion is on the verdict, not on the wiring.
// -----------------------------------------------------------------------------

const NOW = new Date('2026-08-16T18:00:00Z');

function probe(overrides: Record<string, unknown> = {}) {
  return { index: 1, ok: true, status: 200, location: null, reason: undefined, ...overrides };
}

describe('health endpoint body is matched exactly', () => {
  it('accepts exactly {"ok":true}', () => {
    expect(evaluateHealthBody('{"ok":true}').ok).toBe(true);
  });

  it('rejects {"ok":false}', () => {
    expect(evaluateHealthBody('{"ok":false}').ok).toBe(false);
  });

  it('rejects an extra field — a health probe must not start leaking build info', () => {
    const verdict = evaluateHealthBody('{"ok":true,"version":"abc123","env":"production"}');
    expect(verdict.ok).toBe(false);
    // The reason names the keys, never the values, so a leak is not copied
    // into a public CI log by the thing that detected it.
    expect(verdict.reason).toContain('ok');
    expect(verdict.reason).toContain('version');
    expect(verdict.reason).not.toContain('abc123');
    expect(verdict.reason).not.toContain('production');
  });

  it('rejects a non-JSON body', () => {
    expect(evaluateHealthBody('<html>502 Bad Gateway</html>').ok).toBe(false);
  });

  it('rejects an array and a bare string', () => {
    expect(evaluateHealthBody('[]').ok).toBe(false);
    expect(evaluateHealthBody('"ok"').ok).toBe(false);
  });
});

describe('health probe aggregation', () => {
  it('passes when every probe is a clean 200', () => {
    const results = evaluateHealthProbes([probe(), probe({ index: 2 }), probe({ index: 3 })]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('fails health-endpoint when any probe fails', () => {
    const results = evaluateHealthProbes([
      probe(),
      probe({ index: 2, ok: false, status: 503, reason: 'non-200 status' }),
    ]);
    expect(results.find((r) => r.id === 'health-endpoint')!.ok).toBe(false);
  });

  it('tolerates one transient 5xx but fails on two', () => {
    const one = evaluateHealthProbes([
      probe(),
      probe({ index: 2, ok: false, status: 500 }),
      probe({ index: 3 }),
    ]);
    expect(one.find((r) => r.id === 'production-5xx')!.ok).toBe(true);

    const two = evaluateHealthProbes([
      probe({ ok: false, status: 500 }),
      probe({ index: 2, ok: false, status: 502 }),
      probe({ index: 3 }),
    ]);
    expect(two.find((r) => r.id === 'production-5xx')!.ok).toBe(false);
  });

  it('flags an unexpected redirect on the canonical health URL', () => {
    const results = evaluateHealthProbes([
      probe({ ok: false, status: 308, location: 'https://elsewhere.example/api/health' }),
    ]);
    const redirect = results.find((r) => r.id === 'unexpected-redirect')!;
    expect(redirect.ok).toBe(false);
    expect(redirect.detail).toContain('308');
  });
});

describe('TLS certificate check', () => {
  it('passes on a certificate with plenty of life left', () => {
    const result = evaluateTls({ valid_to: 'Nov 10 12:00:00 2026 GMT' }, NOW);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('2026-11-10');
  });

  it('fails when the certificate expires inside the alert window', () => {
    const result = evaluateTls({ valid_to: 'Aug 20 12:00:00 2026 GMT' }, NOW);
    expect(result.ok).toBe(false);
  });

  it('fails when the handshake produced no certificate at all', () => {
    expect(evaluateTls(null, NOW).ok).toBe(false);
  });
});

describe('workflow freshness', () => {
  const base = {
    id: 'backup-freshness',
    title: 'Production backup has not run within its window',
    label: 'Production backup',
    maxAgeMs: 26 * 3_600_000,
    now: NOW,
  };

  it('passes for a run inside the window', () => {
    const result = evaluateWorkflowFreshness({
      ...base,
      latestSuccess: { completedAt: '2026-08-16T01:40:00Z', runId: 42 },
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('run 42');
  });

  it('fails for a run outside the window', () => {
    const result = evaluateWorkflowFreshness({
      ...base,
      latestSuccess: { completedAt: '2026-08-14T01:40:00Z', runId: 41 },
    });
    expect(result.ok).toBe(false);
  });

  it('fails when there has never been a successful run', () => {
    // This is the exact state the project was in before Phase 13: a backup
    // workflow existed and had never once succeeded.
    const result = evaluateWorkflowFreshness({ ...base, latestSuccess: null });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no successful run');
  });
});

describe('cron workflow health', () => {
  function run(minutesAgo: number, conclusion: string, runId = 1) {
    return {
      runId,
      status: 'completed',
      conclusion,
      completedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    };
  }

  it('passes when crons are recent and green', () => {
    const results = evaluateCronHealth([run(5, 'success', 1), run(20, 'success', 2)], NOW);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('fails when the last success is older than the allowed gap', () => {
    const results = evaluateCronHealth([run(200, 'success', 1)], NOW);
    expect(results.find((r) => r.id === 'cron-staleness')!.ok).toBe(false);
  });

  it('fails on repeated failures even when the latest run is green', () => {
    const runs = [
      run(5, 'success', 1),
      run(20, 'failure', 2),
      run(35, 'failure', 3),
      run(50, 'failure', 4),
    ];
    const results = evaluateCronHealth(runs, NOW);
    expect(results.find((r) => r.id === 'cron-staleness')!.ok).toBe(true);
    expect(results.find((r) => r.id === 'cron-failures')!.ok).toBe(false);
  });

  it('ignores runs that are still in progress', () => {
    const runs = [
      { runId: 9, status: 'in_progress', conclusion: null, completedAt: NOW.toISOString() },
      run(5, 'success', 1),
    ];
    const results = evaluateCronHealth(runs, NOW);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe('operational metrics judgement', () => {
  const healthy = {
    outbox: {
      pending: 0,
      processing: 0,
      dead: 0,
      staleClaims: 0,
      oldestPendingAgeSeconds: null,
      deadLast24h: 0,
      deadWithExhaustedRetries: 0,
    },
    housekeeping: { overdueRateLimitRows: 0, overdueExpiredTokens: 0, overdueReauthGrants: 0 },
    retention: { overdueCustomers: 0 },
    auditDigest: { hoursSinceLastQueued: 2 },
    partitions: { monthsAhead: 3, defaultPartitionRows: 0 },
    config: { missingSignupEnv: 0, missingEmailEnv: 0, missingSecurityEnv: 0 },
  };

  it('passes on a completely healthy snapshot', () => {
    const results = evaluateOpsMetrics(healthy);
    const failing = results.filter((r) => !r.ok);
    expect(failing.map((r) => r.id)).toEqual([]);
  });

  it('fails on dead-lettered outbox rows', () => {
    const results = evaluateOpsMetrics({
      ...healthy,
      outbox: { ...healthy.outbox, dead: 2, deadLast24h: 2, deadWithExhaustedRetries: 2 },
    });
    expect(results.find((r) => r.id === 'outbox-dead-letters')!.ok).toBe(false);
  });

  it('fails on stale processing claims', () => {
    const results = evaluateOpsMetrics({
      ...healthy,
      outbox: { ...healthy.outbox, processing: 3, staleClaims: 3 },
    });
    expect(results.find((r) => r.id === 'outbox-stale-claims')!.ok).toBe(false);
  });

  it('fails when the outbox stops draining', () => {
    const results = evaluateOpsMetrics({
      ...healthy,
      outbox: { ...healthy.outbox, pending: 12, oldestPendingAgeSeconds: 6 * 3600 },
    });
    expect(results.find((r) => r.id === 'outbox-backlog')!.ok).toBe(false);
  });

  it('fails when housekeeping stops pruning', () => {
    const results = evaluateOpsMetrics({
      ...healthy,
      housekeeping: { ...healthy.housekeeping, overdueRateLimitRows: 500 },
    });
    expect(results.find((r) => r.id === 'housekeeping-stalled')!.ok).toBe(false);
  });

  it('fails when retention stops anonymising', () => {
    const results = evaluateOpsMetrics({ ...healthy, retention: { overdueCustomers: 3 } });
    const retention = results.find((r) => r.id === 'retention-stalled')!;
    expect(retention.ok).toBe(false);
    // The count is reported; no customer identifier ever is.
    expect(retention.detail).toContain('3');
  });

  it('fails when partition maintenance falls behind or rows land in the default partition', () => {
    expect(
      evaluateOpsMetrics({
        ...healthy,
        partitions: { monthsAhead: 0, defaultPartitionRows: 0 },
      }).find((r) => r.id === 'partition-maintenance')!.ok,
    ).toBe(false);
    expect(
      evaluateOpsMetrics({
        ...healthy,
        partitions: { monthsAhead: 3, defaultPartitionRows: 7 },
      }).find((r) => r.id === 'partition-maintenance')!.ok,
    ).toBe(false);
  });

  it('fails when production is missing required environment configuration', () => {
    // The Phase 13 outage in one assertion: two unset Turnstile variables made
    // every production signup return 400, and nothing was watching.
    const results = evaluateOpsMetrics({
      ...healthy,
      config: { missingSignupEnv: 2, missingEmailEnv: 0, missingSecurityEnv: 0 },
    });
    const config = results.find((r) => r.id === 'production-config-incomplete')!;
    expect(config.ok).toBe(false);
    expect(config.detail).toContain('signup=2');
    // The alert points at the runbook; it never names or prints a value.
    expect(config.detail).toContain('docs/operations.md');
  });

  it('passes when every required variable is set', () => {
    const results = evaluateOpsMetrics(healthy);
    expect(results.find((r) => r.id === 'production-config-incomplete')!.ok).toBe(true);
  });

  it('treats a never-run audit digest as reportable, not an incident', () => {
    const results = evaluateOpsMetrics({
      ...healthy,
      auditDigest: { hoursSinceLastQueued: null },
    });
    const digest = results.find((r) => r.id === 'audit-digest-stalled')!;
    expect(digest.ok).toBe(true);
    expect(digest.detail).toContain('has ever been queued');
  });

  it('fails a digest that used to run and then stopped', () => {
    const results = evaluateOpsMetrics({
      ...healthy,
      auditDigest: { hoursSinceLastQueued: DEFAULTS.auditDigestMaxAgeHours + 1 },
    });
    expect(results.find((r) => r.id === 'audit-digest-stalled')!.ok).toBe(false);
  });
});

describe('incident deduplication', () => {
  const failing = {
    id: 'health-endpoint',
    title: 'Production health endpoint is failing',
    ok: false,
    detail: 'x',
  };
  const passing = {
    id: 'health-endpoint',
    title: 'Production health endpoint is failing',
    ok: true,
    detail: 'y',
  };

  it('opens a new issue the first time a check fails', () => {
    const { toOpen, toComment, toClose } = reconcileIncidents([failing], []);
    expect(toOpen).toHaveLength(1);
    expect(toComment).toHaveLength(0);
    expect(toClose).toHaveLength(0);
  });

  it('comments instead of opening a duplicate when an issue already exists', () => {
    const existing = [{ number: 7, body: `${incidentMarker('health-endpoint')}\nfirst detected` }];
    const { toOpen, toComment } = reconcileIncidents([failing], existing);
    expect(toOpen).toHaveLength(0);
    expect(toComment).toHaveLength(1);
    expect(toComment[0].issue.number).toBe(7);
  });

  it('closes the issue when the check recovers', () => {
    const existing = [{ number: 7, body: `${incidentMarker('health-endpoint')}\nfirst detected` }];
    const { toOpen, toComment, toClose } = reconcileIncidents([passing], existing);
    expect(toOpen).toHaveLength(0);
    expect(toComment).toHaveLength(0);
    expect(toClose).toHaveLength(1);
    expect(toClose[0].issue.number).toBe(7);
  });

  it('does nothing when a passing check has no open issue', () => {
    const { toOpen, toComment, toClose } = reconcileIncidents([passing], []);
    expect([toOpen, toComment, toClose].every((l) => l.length === 0)).toBe(true);
  });

  it('matches by marker, not by title, so a retitled issue is still deduplicated', () => {
    const existing = [
      { number: 9, title: 'something a human renamed', body: incidentMarker('health-endpoint') },
    ];
    const { toOpen, toComment } = reconcileIncidents([failing], existing);
    expect(toOpen).toHaveLength(0);
    expect(toComment[0].issue.number).toBe(9);
  });

  it('keeps incident classes independent', () => {
    const existing = [{ number: 3, body: incidentMarker('tls') }];
    const results = [
      failing,
      { id: 'tls', title: 'TLS', ok: true, detail: 'recovered' },
      { id: 'backup-freshness', title: 'Backup', ok: false, detail: 'stale' },
    ];
    const { toOpen, toClose } = reconcileIncidents(results, existing);
    expect(toOpen.map((o) => o.result.id).sort()).toEqual(['backup-freshness', 'health-endpoint']);
    expect(toClose.map((c) => c.result.id)).toEqual(['tls']);
  });

  it('ignores unrelated open issues that carry no incident marker', () => {
    const existing = [{ number: 4, body: 'a human-written bug report' }];
    const { toOpen, toComment, toClose } = reconcileIncidents([failing], existing);
    expect(toOpen).toHaveLength(1);
    expect(toComment).toHaveLength(0);
    expect(toClose).toHaveLength(0);
  });
});

describe('monitor constants are sane', () => {
  it('uses the incident label the workflow documents', () => {
    expect(INCIDENT_LABEL).toBe('ops-incident');
  });

  it('allows a late daily backup but not a missing one', () => {
    expect(DEFAULTS.backupMaxAgeHours).toBeGreaterThan(24);
    expect(DEFAULTS.backupMaxAgeHours).toBeLessThanOrEqual(36);
  });

  it('treats the restore drill as monthly, not annual', () => {
    expect(DEFAULTS.restoreDrillMaxAgeDays).toBeGreaterThanOrEqual(31);
    expect(DEFAULTS.restoreDrillMaxAgeDays).toBeLessThanOrEqual(62);
  });
});
