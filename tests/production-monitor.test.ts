import { describe, it, expect } from 'vitest';
import {
  DEFAULTS,
  evaluateHealthBody,
  evaluateHealthProbes,
  evaluateTls,
  evaluateWorkflowFreshness,
  evaluateCronHealth,
  evaluateOpsMetrics,
  evaluateAuditDigest,
  incidentAssignees,
  reconcileIncidents,
  OPS_DERIVED_CHECK_IDS,
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

  // ---------------------------------------------------------------------------
  // P15-003. The old behaviour was `hoursSinceLastQueued === null → ok`, full
  // stop, which meant a weekly job that never fired even once reported PASS
  // forever. These four cases pin the two inputs against each other so the
  // "never ran at all" state is actually reachable as a failure.
  // ---------------------------------------------------------------------------

  it('accepts a never-run digest while no organization can receive one', () => {
    const results = evaluateOpsMetrics({
      ...healthy,
      auditDigest: { hoursSinceLastQueued: null, oldestEligibleOrgAgeHours: null },
    });
    const digest = results.find((r) => r.id === 'audit-digest-stalled')!;
    expect(digest.ok).toBe(true);
    expect(digest.detail).toContain('no organization has an emailable owner');
  });

  it('accepts a never-run digest while the oldest eligible org is still inside the window', () => {
    const results = evaluateOpsMetrics({
      ...healthy,
      auditDigest: {
        hoursSinceLastQueued: null,
        oldestEligibleOrgAgeHours: DEFAULTS.auditDigestMaxAgeHours - 1,
      },
    });
    expect(results.find((r) => r.id === 'audit-digest-stalled')!.ok).toBe(true);
  });

  it('FAILS a digest that has never run once an eligible org outlives the window', () => {
    // This is the regression that mattered: GitHub dropped the `0 8 * * 1`
    // schedule on Monday 2026-08-17 and nothing observed it.
    const results = evaluateOpsMetrics({
      ...healthy,
      auditDigest: {
        hoursSinceLastQueued: null,
        oldestEligibleOrgAgeHours: DEFAULTS.auditDigestMaxAgeHours + 1,
      },
    });
    const digest = results.find((r) => r.id === 'audit-digest-stalled')!;
    expect(digest.ok).toBe(false);
    expect(digest.detail).toContain('EVER been queued');
  });

  it('exposes evaluateAuditDigest directly so the branches are unit-testable', () => {
    expect(
      evaluateAuditDigest({
        hoursSinceLastQueued: null,
        oldestEligibleOrgAgeHours: 10_000,
        maxAgeHours: 240,
      }).ok,
    ).toBe(false);
    expect(
      evaluateAuditDigest({
        hoursSinceLastQueued: 1,
        oldestEligibleOrgAgeHours: 10_000,
        maxAgeHours: 240,
      }).ok,
    ).toBe(true);
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

  it('closes an incident whose check is no longer reported at all', () => {
    // Found by the live alert-path test on 2026-08-16: the synthetic
    // `simulated-failure` check only exists while MONITOR_SIMULATE_FAILURE is
    // set, so on the next healthy run it was absent from `results` entirely —
    // not passing, just gone — and its issue stayed open forever. The same
    // would happen to any real check that is renamed or removed.
    const existing = [
      { number: 11, title: '[ops] gone', body: incidentMarker('a-check-that-no-longer-exists') },
    ];
    const { toOpen, toComment, toClose } = reconcileIncidents([passing], existing);
    expect(toOpen).toHaveLength(0);
    expect(toComment).toHaveLength(0);
    expect(toClose).toHaveLength(1);
    expect(toClose[0].issue.number).toBe(11);
    expect(toClose[0].orphaned).toBe(true);
    // …and it must not claim a recovery it never observed.
    expect(toClose[0].result.detail).toContain('no longer reported');
  });

  it('marks a genuine recovery as a recovery, not an orphan', () => {
    const existing = [{ number: 12, body: incidentMarker('health-endpoint') }];
    const { toClose } = reconcileIncidents([passing], existing);
    expect(toClose).toHaveLength(1);
    expect(toClose[0].orphaned).toBeUndefined();
  });

  it('does not close an orphan and a recovery twice for the same issue', () => {
    const existing = [{ number: 13, body: incidentMarker('health-endpoint') }];
    const { toClose } = reconcileIncidents([passing], existing);
    expect(toClose.map((c) => c.issue.number)).toEqual([13]);
  });

  it('leaves a still-failing check open rather than treating it as an orphan', () => {
    const existing = [{ number: 14, body: incidentMarker('health-endpoint') }];
    const { toComment, toClose } = reconcileIncidents([failing], existing);
    expect(toComment).toHaveLength(1);
    expect(toClose).toHaveLength(0);
  });

  it('ignores unrelated open issues that carry no incident marker', () => {
    const existing = [{ number: 4, body: 'a human-written bug report' }];
    const { toOpen, toComment, toClose } = reconcileIncidents([failing], existing);
    expect(toOpen).toHaveLength(1);
    expect(toComment).toHaveLength(0);
    expect(toClose).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// The monitor must not read its own blindness as an all-clear.
//
// On 2026-09-01T00:31:06Z incident #26 — production-config-invalid, the P0
// where FIELD_ENCRYPTION_KEY was set without its key-id prefix — was closed
// automatically with "this check is no longer reported by the monitor". The
// check had not been removed. /api/health/ops was returning 503 because
// production had lost its database, so evaluateOpsMetrics() never ran and none
// of its ids reached the reconciler. Absent was read as gone, and gone was read
// as resolved.
// -----------------------------------------------------------------------------
describe('an unobservable check is not a resolved one', () => {
  const opsDown = {
    id: 'ops-metrics',
    title: 'Operational metrics endpoint is failing',
    ok: false,
    detail: '/api/health/ops returned 503',
  };
  const opsUp = { ...opsDown, ok: true, detail: '/api/health/ops returned 200' };
  const configIncident = [{ number: 26, body: incidentMarker('production-config-invalid') }];

  it('keeps an ops-derived incident OPEN while /api/health/ops is failing', () => {
    const { toClose, toComment } = reconcileIncidents([opsDown], configIncident);
    expect(toClose, 'incident #26 was closed by a probe failure').toHaveLength(0);
    expect(toComment).toHaveLength(1);
    expect(toComment[0].unobservable).toBe(true);
    expect(toComment[0].result.detail).toMatch(/not evaluated this run/);
    // It must not claim the condition is still true either — the point is that
    // nobody knows.
    expect(toComment[0].result.detail).toMatch(/neither confirmed nor cleared/);
  });

  it('COMPLEMENT: closes it as recovered once ops-metrics answers and the check passes', () => {
    const configOk = {
      id: 'production-config-invalid',
      title: 'A required secret is set but structurally unusable',
      ok: true,
      detail: 'security env vars set but malformed: 0',
    };
    const { toClose } = reconcileIncidents([opsUp, configOk], configIncident);
    expect(toClose).toHaveLength(1);
    expect(toClose[0].orphaned).toBeUndefined();
  });

  it('COMPLEMENT: a genuinely removed check is still closed as an orphan', () => {
    // Without this, the fix could have been "never close anything absent",
    // which reintroduces the incident that never closes.
    const removed = [{ number: 99, body: incidentMarker('simulated-failure') }];
    const { toClose } = reconcileIncidents([opsUp], removed);
    expect(toClose).toHaveLength(1);
    expect(toClose[0].orphaned).toBe(true);
  });

  it('COMPLEMENT: a non-ops check absent while ops is down is still an orphan', () => {
    // The exemption is scoped to the ids that /api/health/ops actually feeds.
    // A removed TLS check must not be kept alive by an unrelated outage.
    const removed = [{ number: 98, body: incidentMarker('simulated-failure') }];
    const { toClose } = reconcileIncidents([opsDown], removed);
    expect(toClose).toHaveLength(1);
    expect(toClose[0].orphaned).toBe(true);
  });

  it('OPS_DERIVED_CHECK_IDS matches every id evaluateOpsMetrics can emit', () => {
    // A drifted list silently shrinks the exemption back to nothing. It has
    // caught two real drifts already: `audit-digest-stale` vs
    // `audit-digest-stalled`, and `production-provider-mocked` when the
    // provider split added it.
    //
    // The payload must be COMPLETE. Some checks are omitted for a deployment
    // that predates their metric — see the test below — so evaluating an empty
    // object measures the subset, not the set.
    const complete = {
      config: {
        invalidSecurityEnv: 0,
        missingObservabilityEnv: 0,
        mockedProviderEnv: 0,
        unrecognisedProviderEnv: 0,
      },
    };
    const emitted = evaluateOpsMetrics(complete).map((r: { id: string }) => r.id);
    expect([...OPS_DERIVED_CHECK_IDS].sort()).toEqual([...emitted].sort());
  });

  it('COMPLEMENT: an older deployment emits a strict subset, never an unknown id', () => {
    // Every id an old payload produces must still be in the exemption list, or
    // an incident raised before an upgrade would be closed as an orphan after
    // one.
    const emitted = evaluateOpsMetrics({}).map((r: { id: string }) => r.id);
    expect(emitted.length).toBeGreaterThan(0);
    for (const id of emitted) expect(OPS_DERIVED_CHECK_IDS).toContain(id);
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

// -----------------------------------------------------------------------------
// P15-011 — an alert nobody is pinged about is not an alert.
//
// The monitor opened incidents with a label and no assignee. GitHub pushes to
// a user's inbox, email and mobile app for @mentions and assignments, not for
// issue creation, so every incident this raised was silent.
// .github/workflows/migrate.yml already fixed exactly this in SEC-007 after an
// incident sat unnoticed; the production monitor — the primary alerting path,
// running every 30 minutes — still had the gap. With a single operator and no
// second responder, that is the whole risk.
// -----------------------------------------------------------------------------
describe('P15-011 incident assignment', () => {
  it('defaults to the repository owner', () => {
    expect(incidentAssignees({ GITHUB_REPOSITORY: 'levantchanturidze/bookpitch' })).toEqual([
      'levantchanturidze',
    ]);
  });

  it('honours an explicit override for a future rota', () => {
    expect(
      incidentAssignees({ GITHUB_REPOSITORY: 'owner/repo', INCIDENT_ASSIGNEES: 'alice, bob' }),
    ).toEqual(['alice', 'bob']);
  });

  it('ignores blank entries in the override', () => {
    expect(incidentAssignees({ INCIDENT_ASSIGNEES: 'alice, , ,bob,' })).toEqual(['alice', 'bob']);
  });

  it('degrades to unassigned rather than throwing when it cannot tell', () => {
    // An alert that throws is strictly worse than one that is merely quiet.
    expect(incidentAssignees({})).toEqual([]);
    expect(incidentAssignees({ GITHUB_REPOSITORY: '' })).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Pre-launch delivery gate — monitor side.
//
// A paused job is neither healthy nor broken. Reporting PASS would claim
// digests are being delivered when none are; reporting FAIL would page someone
// about a deliberate decision every 30 minutes forever. It gets its own state.
// -----------------------------------------------------------------------------
describe('audit digest paused state', () => {
  const paused = (over = {}) =>
    evaluateAuditDigest({
      hoursSinceLastQueued: null,
      oldestEligibleOrgAgeHours: 10_000, // would FAIL if delivery were enabled
      maxAgeHours: 240,
      deliveryEnabled: 0,
      deliveryConfigMalformed: 0,
      ...over,
    });

  it('reports paused rather than a false PASS', () => {
    const r = paused();
    expect(r.paused).toBe(true);
    expect(r.detail).toContain('DISABLED BY CONFIGURATION');
  });

  it('does NOT fail, so it cannot open a repeating incident', () => {
    // reconcileIncidents opens on !ok. Paused results are ok, so a paused check
    // never opens an incident no matter how many times the monitor runs.
    const r = paused();
    expect(r.ok).toBe(true);
    const { toOpen } = reconcileIncidents([r], []);
    expect(toOpen).toHaveLength(0);
  });

  it('closes an existing incident as paused, not as recovered', () => {
    const r = paused();
    const issue = { number: 23, body: incidentMarker('audit-digest-stalled') };
    const { toClose, toOpen } = reconcileIncidents([r], [issue]);
    expect(toOpen).toHaveLength(0);
    expect(toClose).toHaveLength(1);
    expect(toClose[0].result.paused).toBe(true);
  });

  it('distinguishes a malformed value from an absent one', () => {
    expect(paused({ deliveryConfigMalformed: 1 }).detail).toMatch(/unrecognised value/i);
    expect(paused({ deliveryConfigMalformed: 0 }).detail).toMatch(/is not "true"/);
  });

  it('returns to real evaluation the moment delivery is enabled', () => {
    // The gate must not permanently silence the check. With delivery on and a
    // digest overdue, it fails exactly as before.
    const r = evaluateAuditDigest({
      hoursSinceLastQueued: null,
      oldestEligibleOrgAgeHours: 10_000,
      maxAgeHours: 240,
      deliveryEnabled: 1,
      deliveryConfigMalformed: 0,
    });
    expect(r.paused).toBeUndefined();
    expect(r.ok).toBe(false);
  });

  it('a deployment predating the gate keeps its previous behaviour', () => {
    // Neither field present -> not paused, evaluated as before.
    const r = evaluateAuditDigest({
      hoursSinceLastQueued: null,
      oldestEligibleOrgAgeHours: 10_000,
      maxAgeHours: 240,
    });
    expect(r.paused).toBeUndefined();
    expect(r.ok).toBe(false);
  });

  it('pausing the digest does not hide unrelated failures', () => {
    // The point of a scoped pause: everything else still reports normally.
    const results = evaluateOpsMetrics(
      {
        outbox: {
          pending: 0,
          processing: 0,
          dead: 4,
          staleClaims: 0,
          oldestPendingAgeSeconds: null,
        },
        housekeeping: { overdueRateLimitRows: 0, overdueExpiredTokens: 0, overdueReauthGrants: 0 },
        retention: { overdueCustomers: 0 },
        auditDigest: {
          hoursSinceLastQueued: null,
          oldestEligibleOrgAgeHours: 10_000,
          deliveryEnabled: 0,
          deliveryConfigMalformed: 0,
        },
        partitions: { monthsAhead: 3, defaultPartitionRows: 0 },
        config: {
          missingSignupEnv: 0,
          missingEmailEnv: 0,
          missingSecurityEnv: 0,
          invalidSecurityEnv: 1,
        },
      },
      DEFAULTS,
    );

    const byId = (id: string) => results.find((c: { id: string }) => c.id === id)!;
    expect(byId('audit-digest-stalled').paused).toBe(true);
    // ...while genuine problems still fail.
    expect(byId('outbox-dead-letters').ok).toBe(false);
    expect(byId('production-config-invalid').ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// A deliberate pre-launch state and a P0 must not share a status line.
//
// Until 2026-09-01 the provider adapters were validated by the same table as
// FIELD_ENCRYPTION_KEY, so production reported "A required secret is set but
// structurally unusable — malformed: 2" while both of them were a payment
// gateway and an SMS provider deliberately left on `mock` before launch. The
// one check that had already caught a real P0 was permanently red for a
// decision, which is how an operator learns to stop reading it.
// -----------------------------------------------------------------------------
describe('mocked providers are separated from malformed secrets', () => {
  const base = { config: {} as Record<string, number> };

  function providerCheck(config: Record<string, number>) {
    return evaluateOpsMetrics({ ...base, config }).find(
      (r: { id: string }) => r.id === 'production-provider-mocked',
    );
  }
  function secretCheck(config: Record<string, number>) {
    return evaluateOpsMetrics({ ...base, config }).find(
      (r: { id: string }) => r.id === 'production-config-invalid',
    );
  }

  it('two mocked providers are PAUSED, not failed', () => {
    const check = providerCheck({ mockedProviderEnv: 2, unrecognisedProviderEnv: 0 });
    expect(check).toBeDefined();
    expect(check!.ok).toBe(true);
    expect(check!.paused).toBe(true);
    expect(check!.detail).toMatch(/DISABLED BY CONFIGURATION/);
    expect(check!.detail).toMatch(/deliberate pre-launch gate/);
  });

  it('a provider that is neither real nor "mock" is a FAIL', () => {
    // The complement that keeps the pause from swallowing a typo.
    const check = providerCheck({ mockedProviderEnv: 1, unrecognisedProviderEnv: 1 });
    expect(check!.ok).toBe(false);
    expect(check!.paused).toBe(false);
    expect(check!.detail).toMatch(/neither a real adapter nor/);
  });

  it('all-real providers pass without pausing', () => {
    const check = providerCheck({ mockedProviderEnv: 0, unrecognisedProviderEnv: 0 });
    expect(check!.ok).toBe(true);
    expect(check!.paused).toBe(false);
  });

  it('a mocked provider no longer makes the secret check fail', () => {
    // The regression this whole split exists to prevent.
    const check = secretCheck({
      invalidSecurityEnv: 0,
      mockedProviderEnv: 2,
      unrecognisedProviderEnv: 0,
    });
    expect(check!.ok).toBe(true);
  });

  it('COMPLEMENT: a malformed secret still fails the secret check', () => {
    // Without this, the split could have been "stop checking secrets".
    const check = secretCheck({
      invalidSecurityEnv: 1,
      mockedProviderEnv: 0,
      unrecognisedProviderEnv: 0,
    });
    expect(check!.ok).toBe(false);
    expect(check!.detail).toMatch(/malformed/);
  });

  it('a deployment predating the provider metric reports no provider check at all', () => {
    // Rather than reporting a green one it has no evidence for.
    const results = evaluateOpsMetrics({ config: { invalidSecurityEnv: 0 } });
    expect(
      results.find((r: { id: string }) => r.id === 'production-provider-mocked'),
    ).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// A stale cron has two causes that need opposite responses.
//
// Measured on this repository 2026-09-01: `*/15 * * * *` was delivered at
// 00:05, 00:27, 05:07, 06:07, 06:24, 07:49, 10:05 and 12:26 UTC — gaps of up
// to 4h39m against a declared 15 minutes. The 90-minute limit encodes
// "reminders run every 15 minutes, so a 90-minute gap means something broke",
// and that premise no longer holds.
//
// The threshold is deliberately NOT raised: reminders really are late, which is
// a real product impact for a booking system. What the check must do is say
// whether the operator should fix the app or accept GitHub's queue.
// -----------------------------------------------------------------------------
describe('a stale cron says which failure it is', () => {
  const NOW = new Date('2026-09-01T14:20:00Z');

  function run(runId: number, conclusion: string, completedAt: string) {
    return { status: 'completed', conclusion, completedAt, runId };
  }

  function staleness(runs: ReturnType<typeof run>[]) {
    return evaluateCronHealth(runs, NOW).find((r: { id: string }) => r.id === 'cron-staleness');
  }

  it('names schedule delivery when the most recent run succeeded', () => {
    const check = staleness([run(33507668170, 'success', '2026-09-01T12:26:30Z')]);
    expect(check!.ok, 'reminders are late; this is still a failure').toBe(false);
    expect(check!.detail).toMatch(/SUCCEEDED/);
    expect(check!.detail).toMatch(/GitHub has not delivered the schedule/);
    expect(check!.detail).toMatch(/the application is not broken/);
  });

  it('names the application when the most recent run failed', () => {
    const check = staleness([
      run(2, 'failure', '2026-09-01T12:30:00Z'),
      run(1, 'success', '2026-09-01T09:00:00Z'),
    ]);
    expect(check!.ok).toBe(false);
    expect(check!.detail).toMatch(/FAILURE/);
    expect(check!.detail).toMatch(/not schedule delivery/);
  });

  it('COMPLEMENT: a fresh successful run is green and gets no cause clause', () => {
    // Without this, appending a cause to everything would look like a pass.
    const check = staleness([run(3, 'success', '2026-09-01T14:00:00Z')]);
    expect(check!.ok).toBe(true);
    expect(check!.detail).not.toMatch(/GitHub has not delivered/);
    expect(check!.detail).not.toMatch(/not schedule delivery/);
  });

  it('COMPLEMENT: the 90-minute limit is unchanged', () => {
    // The cause clause must not become a way to widen the window. 89 minutes
    // passes, 91 does not.
    expect(staleness([run(4, 'success', '2026-09-01T12:52:00Z')])!.ok).toBe(true);
    expect(staleness([run(5, 'success', '2026-09-01T12:48:00Z')])!.ok).toBe(false);
    expect(DEFAULTS.cronMaxAgeMinutes).toBe(90);
  });

  it('no runs at all still reports the original message', () => {
    const check = staleness([]);
    expect(check!.ok).toBe(false);
    expect(check!.detail).toMatch(/no successful run found at all/);
  });
});
