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
  summariseResults,
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

/** A per-job heartbeat entry in the healthy shape. */
function healthyJob(over: Record<string, number | null> = {}) {
  return {
    present: 1,
    outcome: 1,
    successMinutesAgo: 10,
    attemptMinutesAgo: 10,
    expectedUnits: 3,
    processedUnits: 3,
    failedUnits: 0,
    maxAgeMinutes: 360,
    ...over,
  };
}

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
  // `event` is explicit because the two reliability checks read it: only a
  // delivered schedule is evidence that the scheduler is alive. These cases
  // are all about schedule delivery, so they say so.
  // runAttempt defaults to 1: these fixtures stand for runs the scheduler
  // delivered and nobody touched. A rerun (attempt > 1) is covered explicitly
  // in its own describe below.
  function run(
    minutesAgo: number,
    conclusion: string,
    runId = 1,
    event = 'schedule',
    runAttempt = 1,
  ) {
    return {
      runId,
      status: 'completed',
      conclusion,
      completedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
      event,
      runAttempt,
      scheduledAtIsExact: true,
    };
  }

  it('passes when crons are recent and green', () => {
    const results = evaluateCronHealth([run(5, 'success', 1), run(20, 'success', 2)], NOW);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('fails when the last success is older than the allowed gap', () => {
    // 200 minutes trips the delivery-lag warning but not the outage gate; 400
    // trips both. Asserting each on its own check keeps the split honest.
    const lagOnly = evaluateCronHealth([run(200, 'success', 1)], NOW);
    expect(lagOnly.find((r) => r.id === 'cron-delivery-lag')!.ok).toBe(false);
    expect(lagOnly.find((r) => r.id === 'cron-staleness')!.ok).toBe(true);

    const both = evaluateCronHealth([run(400, 'success', 1)], NOW);
    expect(both.find((r) => r.id === 'cron-staleness')!.ok).toBe(false);
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
      {
        runId: 9,
        status: 'in_progress',
        conclusion: null,
        completedAt: NOW.toISOString(),
        event: 'schedule',
      },
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
        // Added with PROVIDER_CONTRACT. `production-provider-unconfigured` is
        // omitted for a deployment that does not report this field, so
        // leaving it out here measures the subset rather than the set — which
        // is the drift this test exists to catch.
        missingProviderEnv: 0,
        missingProviderCredentialEnv: 0,
        deferredProviderEnv: 0,
        undeclaredMockProviderEnv: 0,
      },
      cronHeartbeat: {
        remindersMinutesAgo: 0,
        remindersLastUnits: 0,
        remindersLastOutcome: 1,
        jobsNotSucceeding: 0,
        unremindedStartedAppointments: 0,
        // Per-job evaluation. Each required job emits its own check id, so
        // omitting this would measure a strict subset of what the evaluator
        // can produce — which is the drift this test exists to catch.
        jobs: {
          reminders: healthyJob(),
          housekeeping: healthyJob(),
          retention: healthyJob(),
          auditDigest: healthyJob(),
        },
      },
    };
    // Two mutually exclusive emission shapes now exist, so strict equality
    // against one of them is wrong:
    //
    //   modern  reports cronHeartbeat.jobs -> one `cron-job-<name>` per job
    //   legacy  reports only the scalar    -> a single `cron-jobs-failing`
    //
    // A deployment can never emit both. The property that matters is unchanged:
    // every id either shape can emit must be registered, or an incident raised
    // before an upgrade would be closed as an orphan after one — which is
    // exactly how incident #26 was closed.
    const modern = evaluateOpsMetrics(complete).map((r: { id: string }) => r.id);
    const legacyPayload = {
      ...complete,
      cronHeartbeat: { ...complete.cronHeartbeat, jobs: undefined },
    };
    const legacy = evaluateOpsMetrics(legacyPayload).map((r: { id: string }) => r.id);

    expect(modern, 'the modern shape must emit a check per job').toContain('cron-job-reminders');
    expect(legacy, 'the legacy shape must still emit its aggregate').toContain('cron-jobs-failing');
    expect(modern, 'the two shapes must not both emit').not.toContain('cron-jobs-failing');

    const union = [...new Set([...modern, ...legacy])].sort();
    expect([...OPS_DERIVED_CHECK_IDS].sort()).toEqual(union);
  });

  it('no check id is ever emitted twice', () => {
    // Shipped once: the reminders-missed block was duplicated when the per-job
    // checks were inserted, so production reported it twice in a single run.
    // Two results sharing an id give reconcileIncidents() two verdicts for one
    // incident — whichever it sees last wins — and inflate the gate count, so
    // "25/29 passed" silently counted one check twice.
    const complete = {
      config: {
        invalidSecurityEnv: 0,
        missingObservabilityEnv: 0,
        mockedProviderEnv: 0,
        unrecognisedProviderEnv: 0,
        missingProviderEnv: 0,
        missingProviderCredentialEnv: 0,
        deferredProviderEnv: 0,
        undeclaredMockProviderEnv: 0,
      },
      cronHeartbeat: {
        remindersMinutesAgo: 0,
        remindersLastUnits: 0,
        remindersLastOutcome: 1,
        jobsNotSucceeding: 0,
        unremindedStartedAppointments: 0,
        jobs: {
          reminders: healthyJob(),
          housekeeping: healthyJob(),
          retention: healthyJob(),
          auditDigest: healthyJob(),
        },
      },
    };
    const ids = evaluateOpsMetrics(complete).map((r: { id: string }) => r.id);
    const seen = new Map<string, number>();
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    expect(duplicated, 'these check ids are emitted more than once').toEqual([]);
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
// Measured on this repository 2026-09-01: the 15-minute schedule was delivered
// at 00:05, 00:27, 05:07, 06:07, 06:24, 07:49, 10:05 and 12:26 UTC — gaps of up
// to 4h39m against a declared 15 minutes. The wider sample (191 scheduled runs
// over 12.5 days) puts p99 at 3.02h.
//
// This suite originally asserted that the 90-minute limit must never move,
// which was right about the customer impact and wrong about what a gate is for:
// 13.7% of measured gaps exceed it, so as a release-blocking check it opened
// and closed an incident every seventh interval and nothing could be done about
// any of them.
//
// The observation survives at 90 minutes as `cron-delivery-lag`, informational.
// `cron-staleness` keeps the diagnosis logic and now trips where a delivery lag
// stops being a plausible explanation. Both are asserted below.
// -----------------------------------------------------------------------------
describe('a stale cron says which failure it is', () => {
  const NOW = new Date('2026-09-01T14:20:00Z');

  function run(runId: number, conclusion: string, completedAt: string, event = 'schedule') {
    return {
      status: 'completed',
      conclusion,
      completedAt,
      runId,
      event,
      runAttempt: 1,
      scheduledAtIsExact: true,
    };
  }

  function staleness(runs: ReturnType<typeof run>[]) {
    return evaluateCronHealth(runs, NOW).find((r: { id: string }) => r.id === 'cron-staleness');
  }

  it('names schedule delivery when the most recent run succeeded', () => {
    // 7h54m ago: past the outage threshold, so this is the gate speaking.
    const check = staleness([run(33507668170, 'success', '2026-09-01T06:26:30Z')]);
    expect(check!.ok, 'a gap this size is no longer an ordinary delivery lag').toBe(false);
    expect(check!.detail).toMatch(/SUCCEEDED/);
    expect(check!.detail).toMatch(/GitHub has not delivered the schedule/);
    expect(check!.detail).toMatch(/the application is not broken/);
  });

  it('names the application when the most recent run failed', () => {
    const check = staleness([
      run(2, 'failure', '2026-09-01T06:30:00Z'),
      run(1, 'success', '2026-09-01T02:00:00Z'),
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

  it('COMPLEMENT: the 90-minute observation survives, on the warning line', () => {
    // What must not happen is the tighter signal disappearing. It did not move
    // — it moved CHECKS. 89 minutes passes, 91 does not, exactly as before.
    const lag = (runs: ReturnType<typeof run>[]) =>
      evaluateCronHealth(runs, NOW).find((r: { id: string }) => r.id === 'cron-delivery-lag');
    expect(lag([run(4, 'success', '2026-09-01T12:52:00Z')])!.ok).toBe(true);
    expect(lag([run(5, 'success', '2026-09-01T12:48:00Z')])!.ok).toBe(false);
    expect(DEFAULTS.cronDeliveryLagMinutes).toBe(90);
  });

  it('COMPLEMENT: the gate boundary is exactly where it claims to be', () => {
    // 5h59m passes, 6h01m does not. A threshold nobody probes is a number in a
    // comment.
    expect(staleness([run(6, 'success', '2026-09-01T08:21:00Z')])!.ok).toBe(true);
    expect(staleness([run(7, 'success', '2026-09-01T08:19:00Z')])!.ok).toBe(false);
    expect(DEFAULTS.cronMaxAgeMinutes).toBe(360);
  });

  it('no runs at all still reports the original message', () => {
    const check = staleness([]);
    expect(check!.ok).toBe(false);
    expect(check!.detail).toMatch(/no successful run found at all/);
  });
});

describe('a check points at the table it actually reads', () => {
  it('production-config-invalid names SECRET_ENV_VALIDATORS, not the union', () => {
    // The detail line is the only pointer an operator gets — names never leave
    // the server — so it must name the half of the split this check reads. It
    // said SECURITY_ENV_VALIDATORS for the first run after the split, which is
    // the union and includes the providers this check no longer counts.
    const check = evaluateOpsMetrics({ config: { invalidSecurityEnv: 1 } }).find(
      (r: { id: string }) => r.id === 'production-config-invalid',
    );
    expect(check!.detail).toContain('SECRET_ENV_VALIDATORS');
    expect(check!.detail).not.toContain('SECURITY_ENV_VALIDATORS');
  });
});

// -----------------------------------------------------------------------------
// §4.2 — a manual dispatch is not evidence about the schedule.
//
// On 2026-09-01 the monitor reported `cron-failures` as 1/10 PASS and closed
// incident #38 as "recovered" at 18:45Z. The scheduled-only window at that
// moment was 6 failures out of 10. Five manual dispatches fired between 14:32Z
// and 14:44Z — inside twelve minutes, while an operator was verifying the
// endpoint by hand after the database restore — and displaced six genuinely
// failed scheduled runs out of the ten-run window.
//
// The run ids below are the real ones from that day, so this suite is a
// regression test against the actual incident rather than an invented shape.
// -----------------------------------------------------------------------------
describe('manual dispatches cannot stand in for scheduled evidence', () => {
  const NOW = new Date('2026-09-01T18:45:00Z');

  const scheduled = (runId: number, conclusion: string, at: string, runAttempt = 1) => ({
    runId,
    status: 'completed',
    conclusion,
    completedAt: at,
    event: 'schedule',
    runAttempt,
    scheduledAtIsExact: true,
  });
  const manual = (runId: number, conclusion: string, at: string) => ({
    runId,
    status: 'completed',
    conclusion,
    completedAt: at,
    event: 'workflow_dispatch',
    runAttempt: 1,
    scheduledAtIsExact: true,
  });

  // Exactly what the GitHub API returned that afternoon, newest first.
  const REAL_HISTORY = [
    scheduled(33541926725, 'success', '2026-09-01T18:09:07Z'),
    scheduled(33536493384, 'success', '2026-09-01T17:13:34Z'),
    scheduled(33522243865, 'success', '2026-09-01T14:53:05Z'),
    manual(33521310009, 'success', '2026-09-01T14:44:10Z'),
    manual(33521199799, 'success', '2026-09-01T14:43:05Z'),
    manual(33521146581, 'success', '2026-09-01T14:42:30Z'),
    manual(33521088698, 'success', '2026-09-01T14:41:55Z'),
    manual(33520121839, 'success', '2026-09-01T14:32:35Z'),
    scheduled(33507668170, 'success', '2026-09-01T12:26:29Z'),
    scheduled(33495627804, 'failure', '2026-09-01T10:05:51Z'),
    scheduled(33484027298, 'failure', '2026-09-01T07:50:02Z'),
    scheduled(33477445116, 'failure', '2026-09-01T06:24:23Z'),
    scheduled(33476271477, 'failure', '2026-09-01T06:07:42Z'),
    scheduled(33472358999, 'failure', '2026-09-01T05:07:10Z'),
    scheduled(33454824142, 'failure', '2026-09-01T00:27:39Z'),
    scheduled(33453316896, 'failure', '2026-09-01T00:05:16Z'),
  ];

  const check = (runs: typeof REAL_HISTORY, id: string) =>
    evaluateCronHealth(runs, NOW).find((r: { id: string }) => r.id === id)!;

  it('reproduces the incident: five manual successes cannot clear the window', () => {
    const failures = check(REAL_HISTORY, 'cron-failures');
    // Counting every event, as the monitor used to, the last ten runs contain
    // one failure and this reports PASS. Counting scheduled runs only, the
    // last ten contain six.
    expect(failures.ok, 'six scheduled failures in ten must not read as healthy').toBe(false);
    expect(failures.detail).toMatch(/6\/10 recent SCHEDULED cron runs failed/);
    expect(failures.detail).toMatch(/manual dispatches excluded/);
  });

  it('the displaced scheduled failures are the ones still counted', () => {
    const failures = check(REAL_HISTORY, 'cron-failures');
    // The oldest failure in the scheduled window is the one the manual runs
    // pushed out. Naming the latest failing run keeps the operator pointed at
    // real evidence.
    expect(failures.detail).toMatch(/latest failing run 33495627804/);
  });

  it('a manual success does not refresh cron-staleness', () => {
    // One scheduled run 8 hours ago (beyond the outage threshold), and a manual
    // run one minute ago. Staleness must read 8 hours, not one minute.
    const runs = [
      manual(999, 'success', '2026-09-01T18:44:00Z'),
      scheduled(888, 'success', '2026-09-01T10:45:00Z'),
    ];
    const stale = check(runs, 'cron-staleness');
    expect(stale.ok).toBe(false);
    expect(stale.detail).toMatch(/run 888/);
    expect(stale.detail).not.toMatch(/999/);
  });

  it('manual runs alone are reported as no scheduled delivery at all', () => {
    const runs = [
      manual(1, 'success', '2026-09-01T18:44:00Z'),
      manual(2, 'success', '2026-09-01T18:43:00Z'),
      manual(3, 'success', '2026-09-01T18:42:00Z'),
      manual(4, 'success', '2026-09-01T18:41:00Z'),
      manual(5, 'success', '2026-09-01T18:40:00Z'),
    ];
    const stale = check(runs, 'cron-staleness');
    expect(stale.ok, 'five manual successes are not a working schedule').toBe(false);
    expect(stale.detail).toMatch(/no SCHEDULED run has been delivered/);

    const failures = check(runs, 'cron-failures');
    expect(failures.detail).toMatch(/0\/0 recent SCHEDULED cron runs failed/);
  });

  it('reports the manual dispatch separately, and only as information', () => {
    const info = check(REAL_HISTORY, 'cron-manual-verification');
    expect(info.informational).toBe(true);
    expect(info.ok).toBe(true);
    expect(info.detail).toMatch(/last manual dispatch 33521310009 SUCCESS/);
    expect(info.detail).toMatch(/proves nothing about schedule delivery/);
  });

  it('says so when no manual dispatch has happened', () => {
    const info = check(
      [scheduled(1, 'success', '2026-09-01T18:44:00Z')],
      'cron-manual-verification',
    );
    expect(info.detail).toMatch(/no manual dispatch/);
    expect(info.ok, 'the absence of a manual run is not a fault').toBe(true);
  });

  // The three outcomes need three different responses, so the operator must be
  // able to tell them apart from the status line alone.
  it('distinguishes scheduler delivery failure from application failure', () => {
    const delivery = check([scheduled(1, 'success', '2026-09-01T12:00:00Z')], 'cron-staleness');
    expect(delivery.detail).toMatch(/SUCCEEDED/);
    expect(delivery.detail).toMatch(/GitHub has not delivered the schedule/);

    const application = check(
      [
        scheduled(2, 'failure', '2026-09-01T12:30:00Z'),
        scheduled(1, 'success', '2026-09-01T09:00:00Z'),
      ],
      'cron-staleness',
    );
    expect(application.detail).toMatch(/FAILURE/);
    expect(application.detail).toMatch(/not schedule delivery/);
  });

  // Fail closed. A payload without `event` must not be counted as scheduled
  // evidence — otherwise a GitHub response-shape change would silently
  // reinstate the bug this whole suite exists to prevent.
  it('a run with an unknown trigger is not scheduled evidence', () => {
    const runs = [
      { runId: 7, status: 'completed', conclusion: 'success', completedAt: '2026-09-01T18:44:00Z' },
    ];
    const stale = check(runs as typeof REAL_HISTORY, 'cron-staleness');
    expect(stale.ok).toBe(false);
    expect(stale.detail).toMatch(/no SCHEDULED run has been delivered|no successful run found/);
  });

  // Parity: the informational line must never be able to open, comment on or
  // close an incident, because a manual dispatch is an operator action and its
  // presence or absence is not a production fault.
  it('the informational check is excluded from the incident lifecycle', () => {
    const results = evaluateCronHealth(REAL_HISTORY, NOW);
    const info = results.find((r: { id: string }) => r.id === 'cron-manual-verification')!;

    // Even with an open issue carrying its marker, nothing is closed.
    const openIssues = [
      { number: 99, title: '[ops] manual', body: incidentMarker('cron-manual-verification') },
    ];
    const { toOpen, toComment, toClose } = reconcileIncidents([info], openIssues);
    expect(toOpen).toEqual([]);
    expect(toComment).toEqual([]);
    expect(toClose.map((c: { issue: { number: number } }) => c.issue.number)).not.toContain(99);
  });

  // List/evaluator parity: every id the evaluator emits is accounted for, and
  // the reliability ids are exactly the two that gate the run.
  it('emits exactly the four cron ids, two gating and two informational', () => {
    const results = evaluateCronHealth(REAL_HISTORY, NOW);
    expect(results.map((r: { id: string }) => r.id).sort()).toEqual([
      'cron-delivery-lag',
      'cron-failures',
      'cron-manual-verification',
      'cron-staleness',
    ]);
    // The gating half is what the pass/fail count and the incident reconciler
    // see. `cron-delivery-lag` must stay out of it: it reports a condition
    // nobody can act on, and 13.7% of measured intervals trip it.
    expect(
      results
        .filter((r: { informational?: boolean }) => !r.informational)
        .map((r: { id: string }) => r.id),
    ).toEqual(['cron-staleness', 'cron-failures']);
  });
});

// -----------------------------------------------------------------------------
// §4.5 — the monitor's four provider verdicts.
//
// `mock` used to mean "deliberate pre-launch gate" for ANY provider, read
// straight off the value of the variable. Whether a feature may ship deferred
// is a product decision, and PROVIDER_CONTRACT.deferrable now carries it. A
// mocked EMAIL provider — no signup, no password reset, no audit digest —
// would otherwise have been reported in grey as a deliberate pause forever.
// -----------------------------------------------------------------------------
describe('provider verdicts distinguish a decision from a fault', () => {
  const check = (config: Record<string, number>, id = 'production-provider-mocked') =>
    evaluateOpsMetrics({ config }).find((r: { id: string }) => r.id === id);

  it('an accepted deferral PAUSES', () => {
    const r = check({
      mockedProviderEnv: 2,
      unrecognisedProviderEnv: 0,
      deferredProviderEnv: 2,
      undeclaredMockProviderEnv: 0,
    });
    expect(r!.ok).toBe(true);
    expect(r!.paused).toBe(true);
    expect(r!.detail).toMatch(/accepted deferral/);
  });

  it('an UNaccepted mock FAILS, and says it is not a pre-launch gate', () => {
    const r = check({
      mockedProviderEnv: 3,
      unrecognisedProviderEnv: 0,
      deferredProviderEnv: 2,
      undeclaredMockProviderEnv: 1,
    });
    expect(r!.ok, 'a mocked email provider is not a deliberate pause').toBe(false);
    expect(r!.paused).toBe(false);
    expect(r!.detail).toMatch(/WITHOUT an accepted deferral/);
    expect(r!.detail).toMatch(/silently delivers nothing/);
  });

  it('a typo and an unaccepted mock are both reported when both are present', () => {
    const r = check({
      mockedProviderEnv: 2,
      unrecognisedProviderEnv: 1,
      deferredProviderEnv: 1,
      undeclaredMockProviderEnv: 1,
    });
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/neither a real adapter nor/);
    expect(r!.detail).toMatch(/WITHOUT an accepted deferral/);
  });

  it('a deployment predating the deferral record keeps its old meaning', () => {
    // Not "0 undeclared mocks, therefore healthy" — it has no evidence either
    // way, so it falls back to the previous behaviour and says so.
    const r = check({ mockedProviderEnv: 2, unrecognisedProviderEnv: 0 });
    expect(r!.ok).toBe(true);
    expect(r!.paused).toBe(true);
    expect(r!.detail).toMatch(/predates the per-provider deferral record/);
  });

  it('THE REGRESSION: an unset provider is now reported', () => {
    // PAYMENT_GATEWAY and SMS_PROVIDER were in no required-variable set, so
    // this check did not exist and every count stayed 0 while getGateway()
    // threw on the first call.
    const r = check(
      { missingProviderEnv: 1, missingProviderCredentialEnv: 0 },
      'production-provider-unconfigured',
    );
    expect(r).toBeDefined();
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/provider env vars unset: 1/);
  });

  it('credentials missing for the selected adapter are reported', () => {
    const r = check(
      { missingProviderEnv: 0, missingProviderCredentialEnv: 2 },
      'production-provider-unconfigured',
    );
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/credentials missing for the selected adapter: 2/);
  });

  it('a fully-configured deployment passes', () => {
    const r = check(
      { missingProviderEnv: 0, missingProviderCredentialEnv: 0 },
      'production-provider-unconfigured',
    );
    expect(r!.ok).toBe(true);
  });

  it('a deployment predating the metric reports no check rather than a green one', () => {
    const results = evaluateOpsMetrics({ config: { invalidSecurityEnv: 0 } });
    expect(
      results.find((r: { id: string }) => r.id === 'production-provider-unconfigured'),
    ).toBeUndefined();
  });

  it('the new check is registered so monitor blindness cannot close its incident', () => {
    // Incident #26 was closed as "no longer reported" when the ops probe was
    // failing. A check missing from this list repeats that.
    expect(OPS_DERIVED_CHECK_IDS).toContain('production-provider-unconfigured');
  });
});

// -----------------------------------------------------------------------------
// Defects found by the final false-green review: the monitor let the thing it
// is monitoring decide what gets monitored.
//
// `for (const [job, j] of Object.entries(jobs))` iterates the keys PRODUCTION
// sent, and `const limit = j.maxAgeMinutes` takes the staleness threshold from
// the same document. So a deployment that stops reporting a job stops being
// checked on it, and a deployment that reports a generous limit is graded
// against its own generosity. Neither shows up as a failure; the check simply
// is not there, and 25/29 becomes 24/28 — a number nobody is watching.
//
// The expected job names and their limits are properties of the CONTRACT, not
// observations. They belong to the monitor.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('the monitor decides which jobs it expects, not production', () => {
  const ids = (metrics: Record<string, unknown>) => evaluateOpsMetrics(metrics).map((r) => r.id);
  const find = (metrics: Record<string, unknown>, id: string) =>
    evaluateOpsMetrics(metrics).find((r) => r.id === id);

  const allJobs = () => ({
    reminders: healthyJob(),
    housekeeping: healthyJob(),
    retention: healthyJob({ maxAgeMinutes: 1800 }),
    auditDigest: healthyJob({ maxAgeMinutes: 1800 }),
  });

  it('THE DEFECT: a job production stops reporting still produces a FAILING check', () => {
    // The dangerous shape: the app is redeployed, `retention` disappears from
    // the heartbeat map, and the monitor quietly stops asking about it. An
    // absent job is the case with the least evidence, not the most.
    const jobs = allJobs();
    delete (jobs as Record<string, unknown>).retention;
    const check = find({ cronHeartbeat: { ageMinutes: 5, jobs } }, 'cron-job-retention');
    expect(check, 'cron-job-retention must exist even when production omits it').toBeDefined();
    expect(check!.ok).toBe(false);
    expect(check!.detail).toMatch(/did not report|not reported|absent/i);
  });

  it('an entirely empty job map fails every expected job', () => {
    const results = evaluateOpsMetrics({ cronHeartbeat: { ageMinutes: 5, jobs: {} } });
    for (const id of [
      'cron-job-reminders',
      'cron-job-housekeeping',
      'cron-job-retention',
      'cron-job-audit-digest',
    ]) {
      const c = results.find((r) => r.id === id);
      expect(c, `${id} must be evaluated`).toBeDefined();
      expect(c!.ok, `${id} must fail on an empty map`).toBe(false);
    }
  });

  it('THE DEFECT: a generous limit from production does not excuse a stale job', () => {
    // 20 days old, self-graded against a 100-day limit. The monitor's own limit
    // for reminders is 6 hours.
    const jobs = allJobs();
    jobs.reminders = healthyJob({ successMinutesAgo: 28_800, maxAgeMinutes: 144_000 });
    const check = find({ cronHeartbeat: { ageMinutes: 5, jobs } }, 'cron-job-reminders');
    expect(check!.ok, 'production must not set its own staleness threshold').toBe(false);
  });

  it('a limit tighter than the contract is also ignored — the contract is the contract', () => {
    // The reverse: a deployment reporting an absurdly tight limit must not
    // manufacture an incident either. Drift is drift in both directions.
    const jobs = allJobs();
    jobs.housekeeping = healthyJob({ successMinutesAgo: 30, maxAgeMinutes: 1 });
    const check = find({ cronHeartbeat: { ageMinutes: 5, jobs } }, 'cron-job-housekeeping');
    expect(check!.ok).toBe(true);
  });

  it('an unknown job key from production creates no gate', () => {
    // Otherwise a deployment could add passing checks to its own report card.
    const jobs = { ...allJobs(), somethingNew: healthyJob() };
    expect(ids({ cronHeartbeat: { ageMinutes: 5, jobs } })).not.toContain('cron-job-somethingNew');
  });

  it('the emitted job ids are exactly the four in OPS_DERIVED_CHECK_IDS', () => {
    const emitted = ids({ cronHeartbeat: { ageMinutes: 5, jobs: allJobs() } }).filter((i) =>
      i.startsWith('cron-job-'),
    );
    const declared = OPS_DERIVED_CHECK_IDS.filter(
      (i) => i.startsWith('cron-job-') && i !== 'cron-jobs-failing',
    );
    expect(emitted.sort()).toEqual([...declared].sort());
  });

  it('a healthy full map still passes — the fix must not fail closed on everything', () => {
    const results = evaluateOpsMetrics({ cronHeartbeat: { ageMinutes: 5, jobs: allJobs() } });
    const jobChecks = results.filter(
      (r) => r.id.startsWith('cron-job-') && r.id !== 'cron-jobs-failing',
    );
    expect(jobChecks).toHaveLength(4);
    expect(jobChecks.every((r) => r.ok)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// §4.9 — two different questions were sharing one threshold.
//
// `cron-staleness` fires when no SCHEDULED cron run has succeeded within
// `cronMaxAgeMinutes`, and that number was 90: "reminders run every 15 minutes,
// so a 90-minute gap means something broke". Measured over the last 191
// scheduled runs of `*/15 * * * *` on this account (12.5 days):
//
//   p50 0.44h   p90 2.08h   p95 2.44h   p99 3.02h
//   gaps > 1.5h: 26 of 190 = 13.7%
//   gaps > 6.0h: 1 of 190  — the 7-day Actions billing suspension, an outage
//
// So the premise is false on this account. A 90-minute gap is the ordinary
// behaviour of GitHub's scheduler, and the check opened and closed an incident
// on roughly one interval in seven (#60 was the most recent). An alarm that
// fires that often on a healthy system does not defend the customer; it teaches
// the operator to close it unread, and the next one is the real one.
//
// The 90-minute observation is NOT deleted, because the customer impact is
// real: reminders genuinely are late. It becomes a warning that is reported and
// never opens an incident. The release-blocking threshold moves to where it
// actually discriminates an outage from a delivery lag.
//
// This is not a threshold raised to go green. Both signals still exist, both
// are still emitted, and the tighter one is still visible on every run.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('cron delivery lag and cron outage are different claims', () => {
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  const run = (over: Record<string, unknown> = {}) => ({
    runId: 1,
    status: 'completed',
    runAttempt: 1,
    scheduledAtIsExact: true,

    conclusion: 'success',
    completedAt: at(0.2),
    event: 'schedule',
    ...over,
  });
  const byId = (runs: ReturnType<typeof run>[], id: string) =>
    evaluateCronHealth(runs, NOW).find((r) => r.id === id);

  it('THE DEFECT: a 2h delivery gap does not open an incident', () => {
    // p90 on this account. Nothing is broken and nothing is actionable.
    const stale = byId([run({ completedAt: at(2) })], 'cron-staleness');
    expect(stale!.ok, 'a p90 delivery gap must not be a release-blocking failure').toBe(true);
  });

  it('…but it is still REPORTED — the customer impact does not disappear', () => {
    const lag = byId([run({ completedAt: at(2) })], 'cron-delivery-lag');
    expect(lag, 'the 90-minute observation must still be emitted').toBeDefined();
    expect(lag!.ok).toBe(false);
    expect(lag!.detail).toMatch(/late/i);
  });

  it('the lag warning is informational, so it can never open or close an incident', () => {
    const lag = byId([run({ completedAt: at(2) })], 'cron-delivery-lag');
    expect(lag!.informational).toBe(true);
    // Belt and braces: prove it through the reconciler, not just the flag.
    const plan = reconcileIncidents([lag!], []);
    expect(plan.toOpen).toEqual([]);
  });

  it('a gap beyond the outage threshold IS release-blocking', () => {
    const stale = byId([run({ completedAt: at(7) })], 'cron-staleness');
    expect(stale!.ok, '7h exceeds anything measured short of an outage').toBe(false);
  });

  it('a normal gap trips neither', () => {
    const results = evaluateCronHealth([run({ completedAt: at(0.4) })], NOW);
    expect(results.find((r) => r.id === 'cron-staleness')!.ok).toBe(true);
    expect(results.find((r) => r.id === 'cron-delivery-lag')!.ok).toBe(true);
  });

  it('a FAILED scheduled run is still the application, at either threshold', () => {
    // The distinction the delivery/outage split must not blur: if the schedule
    // arrived and the run failed, that is not a delivery problem at all.
    const stale = byId([run({ completedAt: at(2), conclusion: 'failure' })], 'cron-staleness');
    expect(stale!.ok, 'a failed scheduled run is not excused by the delivery window').toBe(false);
    expect(stale!.detail).toMatch(/not schedule delivery|application or the endpoint/i);
  });

  it('no scheduled run at all is release-blocking regardless of gap size', () => {
    const stale = byId([run({ event: 'workflow_dispatch' })], 'cron-staleness');
    expect(stale!.ok).toBe(false);
    expect(stale!.detail).toMatch(/no SCHEDULED run/i);
  });

  it('both ids are registered so neither is an orphan to the reconciler', () => {
    const ids = evaluateCronHealth([run()], NOW).map((r) => r.id);
    expect(ids).toContain('cron-staleness');
    expect(ids).toContain('cron-delivery-lag');
  });
});

// -----------------------------------------------------------------------------
// The PROCESS VERDICT, not just the incident reconciler.
//
// `cron-delivery-lag` was made informational so a 90-minute delivery gap would
// be reported without being a gate. It was excluded from incident
// reconciliation and from the "N/M checks passed" line — and then the exit code
// was computed from `results.filter((r) => !r.ok)`, which includes it.
//
// So the workflow still failed. A failed SCHEDULED monitor run is exactly what
// the soak controller treats as a release-critical failure, so an informational
// observation reset the soak window. Measured: 13.7% of cron gaps exceed 90
// minutes, so roughly one monitor run in seven.
//
// The split was defeated by the one line that never learned about it, and every
// test looked at reconcileIncidents() rather than at what the process does.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('the process verdict excludes informational observations', () => {
  const gate = (id: string, ok: boolean) => ({ id, title: id, ok, detail: id });
  const info = (id: string, ok: boolean) => ({ ...gate(id, ok), informational: true });
  const paused = (id: string) => ({ ...gate(id, true), paused: true });

  it('THE DEFECT: a failing informational line does not make the run unhealthy', () => {
    const s = summariseResults([
      gate('a', true),
      gate('b', true),
      info('cron-delivery-lag', false),
    ]);
    expect(s.healthy, 'an observation nobody can act on must not fail the workflow').toBe(true);
    expect(s.failingGates).toEqual([]);
  });

  it('THE DEFECT: it is not counted against the denominator or the numerator', () => {
    const s = summariseResults([gate('a', true), gate('b', true), info('c', false)]);
    expect(s.gateCount).toBe(2);
    expect(s.passedCount, '"2/2 passed" must stay true').toBe(2);
    expect(s.infoCount).toBe(1);
  });

  it('…but it is still surfaced, so it cannot be quietly lost', () => {
    const s = summariseResults([gate('a', true), info('c', false)]);
    expect(s.failingInformational.map((r) => r.id)).toEqual(['c']);
  });

  it('a failing GATE still makes the run unhealthy', () => {
    const s = summariseResults([gate('a', false), info('c', true)]);
    expect(s.healthy).toBe(false);
    expect(s.failingGates.map((r) => r.id)).toEqual(['a']);
  });

  it('a paused gate is neither passed nor failed', () => {
    const s = summariseResults([gate('a', true), paused('b')]);
    expect(s.healthy).toBe(true);
    expect(s.gateCount).toBe(2);
    expect(s.passedCount).toBe(1);
    expect(s.pausedCount).toBe(1);
  });

  it('a paused gate reporting !ok is still not a failure', () => {
    const s = summariseResults([{ ...gate('b', false), paused: true }]);
    expect(s.healthy).toBe(true);
    expect(s.failingGates).toEqual([]);
  });

  it('THE REGRESSION: the real cron split cannot fail a healthy run', () => {
    // The exact shape production produces during an ordinary delivery lag.
    const runs = [
      {
        runId: 1,
        status: 'completed',
        runAttempt: 1,
        scheduledAtIsExact: true,

        conclusion: 'success',
        completedAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
        event: 'schedule',
      },
    ];
    const s = summariseResults(evaluateCronHealth(runs, NOW));
    expect(s.healthy, 'a 2h delivery gap is p90 behaviour, not a failure').toBe(true);
    expect(s.failingInformational.map((r) => r.id)).toContain('cron-delivery-lag');
  });

  it('COMPLEMENT: the OLD predicate disagrees on exactly this input', () => {
    // Proof that the tests above discriminate rather than restating whatever
    // the code now does. The defect was `results.filter((r) => !r.ok)` next to
    // the exit call; applied to the same results it still says "fail".
    const results = [gate('a', true), gate('b', true), info('cron-delivery-lag', false)];
    const oldPredicate = results.filter((r) => !r.ok);
    expect(oldPredicate.length, 'the old filter counted the informational line').toBe(1);
    expect(summariseResults(results).healthy, 'the new verdict does not').toBe(true);
  });

  it('the exit path reads this verdict and nothing else', async () => {
    // The defect was a second, divergent filter next to the exit call. One
    // verdict, computed once — asserted at source level because the process
    // exit itself cannot be observed from here.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('scripts/production-monitor.mjs', 'utf8');
    const exitBlock = src.slice(
      src.indexOf('// --- Alerting'),
      src.indexOf('async function ensureLabel'),
    );
    expect(exitBlock).toMatch(/if \(!summary\.healthy\)/);
    expect(exitBlock, 'no re-filtering next to the exit').not.toMatch(/results\.filter/);
  });
});

// -----------------------------------------------------------------------------
// §3 — a re-run is not unattended operation.
//
// The 2026-09-01 incident was manual DISPATCHES displacing scheduled failures.
// The same move survives through a different button: "Re-run failed jobs" keeps
// the run's `schedule` event, increments `run_attempt`, replaces `conclusion`
// and moves `updated_at`. Filtering on the event alone let a human turn a
// failed scheduled run green, and the API returns the latest attempt.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('re-running a scheduled run cannot make the monitor green', () => {
  const NOW2 = new Date('2026-09-01T18:45:00Z');
  const at = (h: number) => new Date(NOW2.getTime() - h * 3_600_000).toISOString();
  const r = (over: Record<string, unknown>) => ({
    runId: 1,
    status: 'completed',
    conclusion: 'success',
    completedAt: at(0.2),
    event: 'schedule',
    runAttempt: 1,
    scheduledAtIsExact: true,

    ...over,
  });
  const find = (runs: ReturnType<typeof r>[], id: string) =>
    evaluateCronHealth(runs, NOW2).find((x) => x.id === id)!;

  it('THE DEFECT: a failed scheduled run re-run into success is not fresh evidence', () => {
    // What an operator sees after pressing the button: schedule event, success,
    // recent — and attempt 2.
    const check = find([r({ runAttempt: 2, completedAt: at(0.1) })], 'cron-staleness');
    expect(check.ok, 'a re-run is a button press, not schedule delivery').toBe(false);
    expect(check.detail).toMatch(/no SCHEDULED run/i);
  });

  it('a re-run does not count toward the recent-failure window either', () => {
    // Ten genuinely failed first attempts, then someone re-runs three of them.
    // The failures must still be counted; the re-runs must not displace them.
    const runs = [
      ...Array.from({ length: 3 }, (_, i) =>
        r({ runId: 900 + i, runAttempt: 2, conclusion: 'success', completedAt: at(0.1) }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        r({ runId: 800 + i, conclusion: 'failure', completedAt: at(1 + i) }),
      ),
      r({ runId: 700, conclusion: 'success', completedAt: at(8) }),
    ];
    const failures = find(runs, 'cron-failures');
    expect(failures.ok, '6 genuine failures must not be hidden by 3 re-runs').toBe(false);
  });

  it('a first-attempt success right after a re-run IS accepted', () => {
    // The complement. Once the scheduler delivers again on its own, the
    // evidence is natural and the check recovers — otherwise this rule would
    // make a re-run permanently poisonous.
    const runs = [
      r({ runId: 2, completedAt: at(0.1) }),
      r({ runId: 1, runAttempt: 3, completedAt: at(0.2) }),
    ];
    expect(find(runs, 'cron-staleness').ok).toBe(true);
  });

  it('a re-run is REPORTED, not silently dropped', () => {
    // An operator who pressed the button should see that it did not count,
    // rather than watching the check stay red for no visible reason.
    const results = evaluateCronHealth([r({ runAttempt: 2 })], NOW2);
    const notice = results.find((x) => x.id === 'cron-rerun-notice');
    expect(notice, 'a re-run must be visible').toBeDefined();
    expect(notice!.informational, 'and must not be a gate').toBe(true);
    expect(notice!.detail).toMatch(/run_attempt > 1/);
  });

  it('no notice appears when nothing was re-run', () => {
    const ids = evaluateCronHealth([r({})], NOW2).map((x) => x.id);
    expect(ids).not.toContain('cron-rerun-notice');
  });

  it('an unknown run_attempt fails closed', () => {
    const check = find([{ ...r({}), runAttempt: undefined } as never], 'cron-staleness');
    expect(check.ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// §7 — a check may raise an alarm without being competent to declare it over.
//
// `production-observability-unconfigured` counts how many Sentry DSN env vars
// are UNSET. That is a real fault when it is non-zero, and it is what opened
// #44. But zero only means "two names are present": a revoked DSN, a DSN for a
// deleted project, or a typo all count as configured.
//
// So the moment somebody pastes any two strings, this check goes green and
// CLOSES #44 — the incident whose entire subject is whether errors actually
// reach a human. Presence is not delivery, and this check cannot tell the
// difference.
//
// The end-to-end verifier can: it makes the deployed app emit real events in
// both runtimes, reads them back through Sentry's API, and checks release,
// environment, nonce, runtime and symbolication. That is the authority for
// closing #44.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('the observability check can open an incident but never close one', () => {
  const check = (missing: number) =>
    evaluateOpsMetrics({ config: { missingObservabilityEnv: missing } }).find(
      (r: { id: string }) => r.id === 'production-observability-unconfigured',
    )!;

  it('still fails, and still opens an incident, when a DSN is missing', () => {
    const r = check(2);
    expect(r.ok).toBe(false);
    expect(reconcileIncidents([r], []).toOpen.map((o) => o.result.id)).toEqual([
      'production-observability-unconfigured',
    ]);
  });

  it('THE DEFECT: presence alone must not close the incident', () => {
    const r = check(0);
    expect(r.ok, 'two names present is a legitimate pass for a CONFIG check').toBe(true);
    const open = [
      { number: 44, body: incidentMarker('production-observability-unconfigured'), title: 'x' },
    ];
    const plan = reconcileIncidents([r], open);
    expect(plan.toClose, 'a config check cannot certify that errors reach a human').toEqual([]);
  });

  it('the check says why it is not the authority', () => {
    expect(check(0).detail).toMatch(/presence|not proof|does not prove/i);
  });

  it('COMPLEMENT: an ordinary check still closes its own incident', () => {
    // The `canClose` flag must be narrow, not a general weakening of recovery.
    const ok = { id: 'outbox-dead-letters', title: 't', ok: true, detail: 'd' };
    const open = [{ number: 9, body: incidentMarker('outbox-dead-letters'), title: 'x' }];
    expect(reconcileIncidents([ok], open).toClose.map((c) => c.issue.number)).toEqual([9]);
  });

  it('a check that cannot close is still not able to open twice', () => {
    const r = check(2);
    const open = [
      { number: 44, body: incidentMarker('production-observability-unconfigured'), title: 'x' },
    ];
    const plan = reconcileIncidents([r], open);
    expect(plan.toOpen).toEqual([]);
    expect(plan.toComment.map((c) => c.issue.number)).toEqual([44]);
  });
});

// -----------------------------------------------------------------------------
// An incident closed while its check is still failing must be REOPENED, not
// duplicated.
//
// Found the hard way on 2026-09-04. A pull-request body containing the words
// "the verifier closes #44 by evidence" was parsed by GitHub as a closing
// keyword, and merging that PR closed the observability incident — while the
// DSNs were still unset and the check was still failing. So an incident can be
// closed by something with no opinion about the underlying condition, and
// `canClose: false` cannot prevent it: that flag governs THIS monitor, not
// GitHub's issue automation, a stray comment, or a person tidying up.
//
// The monitor recovered, which is the good news: the next natural run saw no
// open issue with the marker and opened a fresh one. But it opened a NEW
// number, so three days of history — first detection, every "still failing"
// comment — was orphaned on the old issue, and anyone following the incident
// was following a dead link.
//
// Reopening is strictly better: same number, same history, and the record shows
// that it was closed and why that was wrong.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('a wrongly closed incident is reopened, not duplicated', () => {
  const failing = {
    id: 'production-observability-unconfigured',
    title: 't',
    ok: false,
    detail: 'd',
  };
  const closed = (number: number) => ({
    number,
    title: 't',
    body: incidentMarker('production-observability-unconfigured'),
    state: 'closed',
  });

  it('THE DEFECT: a closed issue with the marker is reopened, not re-created', () => {
    const plan = reconcileIncidents([failing], [], [closed(44)]);
    expect(
      plan.toReopen.map((r) => r.issue.number),
      'the history lives on #44',
    ).toEqual([44]);
    expect(plan.toOpen, 'a second issue would orphan three days of history').toEqual([]);
  });

  it('with no closed issue either, it opens a fresh one', () => {
    const plan = reconcileIncidents([failing], [], []);
    expect(plan.toOpen.map((o) => o.result.id)).toEqual(['production-observability-unconfigured']);
    expect(plan.toReopen).toEqual([]);
  });

  it('an OPEN issue is commented on, never reopened', () => {
    const open = [{ ...closed(44), state: 'open' }];
    const plan = reconcileIncidents([failing], open, [closed(44)]);
    expect(plan.toComment.map((c) => c.issue.number)).toEqual([44]);
    expect(plan.toReopen).toEqual([]);
    expect(plan.toOpen).toEqual([]);
  });

  it('a PASSING check does not reopen anything', () => {
    // The complement, and the one that matters: reopening must be driven by the
    // check still failing, not by the issue merely being closed.
    const ok = { ...failing, ok: true };
    expect(reconcileIncidents([ok], [], [closed(44)]).toReopen).toEqual([]);
  });

  it('the OLDEST closed issue is chosen when several carry the marker', () => {
    // Superseded expectation: this asserted the highest number. The canonical
    // issue for a marker is the oldest, because that is where the history is —
    // choosing the newest is what left #44 stranded while #67 accumulated
    // comments.
    const plan = reconcileIncidents([failing], [], [closed(12), closed(44)]);
    expect(plan.toReopen.map((r) => r.issue.number)).toEqual([12]);
    expect(plan.toCloseDuplicate.map((d) => d.issue.number)).toEqual([]);
  });

  it('informational results never reopen anything', () => {
    const info = { ...failing, informational: true };
    expect(reconcileIncidents([info], [], [closed(44)]).toReopen).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// §2.7 — the canonical incident is the FIRST one, not the newest.
//
// PR #69 added reopening, but chose the highest-numbered closed issue as the
// one to reopen, and only looked at closed issues when none was open. Against
// the live state — #44 closed by a stray PR keyword, #67 opened by the next
// monitor run — it therefore does nothing at all: #67 is open, so the
// reconciler comments on #67 forever and #44 stays closed with three days of
// history stranded on it.
//
// The canonical issue for a marker is the OLDEST one, because that is where the
// history is. Duplicates are closed as duplicates, and only after the canonical
// one is open.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('the canonical incident is the oldest, and duplicates are folded into it', () => {
  const MARKER = 'production-observability-unconfigured';
  const failing = { id: MARKER, title: 't', ok: false, detail: 'still failing' };
  const issue = (number: number, state: string) => ({
    number,
    state,
    title: 't',
    body: incidentMarker(MARKER),
  });

  it('THE LIVE CASE: canonical closed, duplicate open — reopen 44, close 67', () => {
    const plan = reconcileIncidents([failing], [issue(67, 'open')], [issue(44, 'closed')]);
    expect(
      plan.toReopen.map((r) => r.issue.number),
      'the history lives on #44',
    ).toEqual([44]);
    expect(plan.toCloseDuplicate.map((d) => d.issue.number)).toEqual([67]);
    expect(plan.toOpen, 'a third issue would be absurd').toEqual([]);
  });

  it('exactly one issue is left open for the marker', () => {
    const plan = reconcileIncidents([failing], [issue(67, 'open')], [issue(44, 'closed')]);
    const openAfter = new Set([67]);
    for (const r of plan.toReopen) openAfter.add(r.issue.number);
    for (const d of plan.toCloseDuplicate) openAfter.delete(d.issue.number);
    expect([...openAfter]).toEqual([44]);
  });

  it('several open duplicates: keep the oldest, close the rest', () => {
    const plan = reconcileIncidents(
      [failing],
      [issue(67, 'open'), issue(71, 'open'), issue(44, 'open')],
      [],
    );
    expect(plan.toComment.map((c) => c.issue.number)).toEqual([44]);
    expect(plan.toCloseDuplicate.map((d) => d.issue.number).sort()).toEqual([67, 71]);
  });

  it('several closed duplicates: reopen the oldest only', () => {
    const plan = reconcileIncidents([failing], [], [issue(67, 'closed'), issue(44, 'closed')]);
    expect(plan.toReopen.map((r) => r.issue.number)).toEqual([44]);
  });

  it('a recovered check closes every issue for the marker, canonical included', () => {
    // Evidence-based recovery must not leave a duplicate open behind it.
    const recovered = { ...failing, ok: true };
    const plan = reconcileIncidents([recovered], [issue(44, 'open'), issue(67, 'open')], []);
    expect(plan.toClose.map((c) => c.issue.number).sort()).toEqual([44, 67]);
  });

  it('a canClose:false check still closes nothing', () => {
    const recovered = { ...failing, ok: true, canClose: false };
    const plan = reconcileIncidents([recovered], [issue(44, 'open')], []);
    expect(plan.toClose).toEqual([]);
  });

  it('no issues at all still opens one', () => {
    expect(reconcileIncidents([failing], [], []).toOpen.map((o) => o.result.id)).toEqual([MARKER]);
  });

  it('unrelated markers are untouched', () => {
    const other = { number: 9, state: 'open', title: 'x', body: incidentMarker('outbox-backlog') };
    const plan = reconcileIncidents([failing], [issue(67, 'open'), other], [issue(44, 'closed')]);
    expect(plan.toCloseDuplicate.map((d) => d.issue.number)).toEqual([67]);
  });
});

// -----------------------------------------------------------------------------
// The canonical issue must survive pagination.
//
// The closed-incident query is a single page. Fetched newest-first, the OLDEST
// issue carrying a marker — which is the canonical one — falls off the end as
// soon as there is more than a page of closed incidents, and the reconciler
// opens a duplicate of an issue it simply could not see.
//
// Latent rather than live today (14 closed incidents against a 100 cap), and
// exactly the shape that is invisible until it is not.
// -----------------------------------------------------------------------------
describe('the canonical issue is not paginated away', () => {
  it('closed incidents are fetched OLDEST first', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['scripts/production-monitor.mjs', 'scripts/sentry-incident.mjs']) {
      const src = readFileSync(f, 'utf8');
      const q = /state=closed[^`]*/.exec(src)?.[0] ?? '';
      expect(q, `${f} closed-issue query`).toMatch(/direction=asc/);
      expect(q, `${f} must not fetch newest-first`).not.toMatch(/direction=desc/);
    }
  });

  it('and the reconciler picks the oldest even when the newest is listed first', () => {
    // Order-independence at the logic level, so the query and the choice cannot
    // disagree.
    const marker = incidentMarker('production-observability-unconfigured');
    const issue = (number: number, state: string) => ({ number, state, title: 't', body: marker });
    const failing = {
      id: 'production-observability-unconfigured',
      title: 't',
      ok: false,
      detail: 'd',
    };
    const newestFirst = reconcileIncidents(
      [failing],
      [],
      [issue(67, 'closed'), issue(44, 'closed')],
    );
    const oldestFirst = reconcileIncidents(
      [failing],
      [],
      [issue(44, 'closed'), issue(67, 'closed')],
    );
    expect(newestFirst.toReopen.map((r) => r.issue.number)).toEqual([44]);
    expect(oldestFirst.toReopen.map((r) => r.issue.number)).toEqual([44]);
  });
});
