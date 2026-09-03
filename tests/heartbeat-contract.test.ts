import { describe, it, expect } from 'vitest';
import {
  EXPECTED_HEARTBEAT_JOBS,
  evaluateHeartbeatJob,
  unhealthyJobsFrom,
} from '../scripts/heartbeat-contract.mjs';
import {
  HEARTBEAT_JOBS,
  HEARTBEAT_MAX_AGE_MINUTES,
  HEARTBEAT_METRIC_KEY,
} from '@/lib/cron-heartbeat-jobs';

// -----------------------------------------------------------------------------
// §4.2 — one authoritative contract, held locally, shared by every consumer.
//
// The monitor was fixed in cb1b8f7 to grade against its own job list and its
// own thresholds instead of the ones production reports. The soak controller
// was not: it still did
//
//     Object.entries(jobs).filter(([, j]) => … j.successMinutesAgo > j.maxAgeMinutes …)
//
// which is the identical defect in the identical shape, on the gate that
// decides whether a 24-hour window counts. A deployment that stopped reporting
// `retention` would have had `retention` silently drop out of the soak's
// health check, and a deployment reporting `maxAgeMinutes: 999999` would have
// been graded against its own generosity for a whole day.
//
// Two copies of a contract is one copy too many, so the contract now lives in
// exactly one module and both consumers import it.
//
// Written to FAIL first — scripts/heartbeat-contract.mjs did not exist.
// -----------------------------------------------------------------------------

/** A healthy entry as the ops endpoint reports it. */
const healthy = (over: Record<string, unknown> = {}) => ({
  present: 1,
  outcome: 1,
  successMinutesAgo: 10,
  attemptMinutesAgo: 10,
  expectedUnits: 3,
  processedUnits: 3,
  failedUnits: 0,
  maxAgeMinutes: 360,
  ...over,
});

const allHealthy = () => ({
  reminders: healthy(),
  housekeeping: healthy(),
  retention: healthy({ maxAgeMinutes: 1800 }),
  auditDigest: healthy({ maxAgeMinutes: 1800 }),
});

describe('the contract is local, complete, and mirrors the application', () => {
  it('names exactly the four jobs, with the same keys and limits as the app', () => {
    const fromApp = HEARTBEAT_JOBS.map((job) => ({
      metricKey: HEARTBEAT_METRIC_KEY[job],
      checkId: `cron-job-${job}`,
      maxAgeMinutes: HEARTBEAT_MAX_AGE_MINUTES[job],
    })).sort((a, b) => a.metricKey.localeCompare(b.metricKey));

    expect(
      [...EXPECTED_HEARTBEAT_JOBS].sort((a, b) => a.metricKey.localeCompare(b.metricKey)),
      'the shared contract has drifted from lib/cron-heartbeat-jobs.ts',
    ).toEqual(fromApp);
  });

  it('is frozen — a consumer cannot mutate the contract it is graded by', () => {
    expect(Object.isFrozen(EXPECTED_HEARTBEAT_JOBS)).toBe(true);
  });
});

describe('a single job entry is judged against the LOCAL limit', () => {
  const limit = 360;

  it('accepts a healthy, fresh, complete entry', () => {
    expect(evaluateHeartbeatJob('reminders', healthy(), limit).ok).toBe(true);
  });

  it('THE DEFECT: a generous remote limit does not excuse a stale job', () => {
    const v = evaluateHeartbeatJob(
      'reminders',
      healthy({ successMinutesAgo: 28_800, maxAgeMinutes: 144_000 }),
      limit,
    );
    expect(v.ok, 'production must not set the threshold it is graded by').toBe(false);
    expect(v.reason).toMatch(/last succeeded/);
  });

  it('a tighter remote limit does not manufacture a failure either', () => {
    expect(evaluateHeartbeatJob('housekeeping', healthy({ maxAgeMinutes: 1 }), limit).ok).toBe(true);
  });

  it('a missing entry is a failure, not an absence of opinion', () => {
    const v = evaluateHeartbeatJob('retention', null, limit);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not reported/i);
  });

  it('never having run is a failure', () => {
    const v = evaluateHeartbeatJob('reminders', healthy({ present: 0 }), limit);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/has not completed once/i);
  });

  it('an unknown outcome is NOT VERIFIED, which is not a pass', () => {
    const v = evaluateHeartbeatJob('reminders', healthy({ outcome: null }), limit);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no outcome/i);
  });

  it('a partial or failed outcome fails', () => {
    expect(evaluateHeartbeatJob('reminders', healthy({ outcome: 0 }), limit).ok).toBe(false);
    expect(evaluateHeartbeatJob('reminders', healthy({ outcome: -1 }), limit).ok).toBe(false);
  });

  it('a success that processed fewer units than it expected is not a success', () => {
    const v = evaluateHeartbeatJob(
      'reminders',
      healthy({ expectedUnits: 10, processedUnits: 4 }),
      limit,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/4 of 10/);
  });

  it('THE DEFECT: an invalid timestamp is refused, not coerced', () => {
    // `successMinutesAgo > limit` is false for a string, for NaN, and for a
    // negative number, so every one of them passed as "fresh".
    for (const bad of [null, undefined, 'soon', NaN, Infinity, -5, {}, []]) {
      const v = evaluateHeartbeatJob(
        'reminders',
        healthy({ successMinutesAgo: bad as number }),
        limit,
      );
      expect(v.ok, `successMinutesAgo=${JSON.stringify(bad)} must not pass`).toBe(false);
    }
  });
});

describe('the whole map is judged against the contract, not its own keys', () => {
  it('a fully healthy map yields no unhealthy jobs', () => {
    expect(unhealthyJobsFrom(allHealthy())).toEqual([]);
  });

  it('THE DEFECT: a job production omits is unhealthy, not absent', () => {
    const jobs = allHealthy();
    delete (jobs as Record<string, unknown>).retention;
    expect(unhealthyJobsFrom(jobs)).toContain('retention');
  });

  it('an empty map fails every required job', () => {
    expect(unhealthyJobsFrom({})!.sort()).toEqual(
      [...EXPECTED_HEARTBEAT_JOBS].map((j) => j.metricKey).sort(),
    );
  });

  it('a missing map is null — unreadable is not healthy', () => {
    // The soak gate reads null as "could not be read" and refuses the window.
    // Returning [] here would certify a day on no evidence at all.
    expect(unhealthyJobsFrom(null)).toBeNull();
    expect(unhealthyJobsFrom(undefined)).toBeNull();
    expect(unhealthyJobsFrom('not an object' as unknown as object)).toBeNull();
    expect(unhealthyJobsFrom([] as unknown as object)).toBeNull();
  });

  it('an unknown job key cannot add or remove health', () => {
    const jobs = { ...allHealthy(), somethingNew: healthy() };
    expect(unhealthyJobsFrom(jobs)).toEqual([]);
    const broken = { ...allHealthy(), somethingNew: healthy({ outcome: -1 }) };
    expect(unhealthyJobsFrom(broken), 'an unknown job must not fail the soak').toEqual([]);
  });

  it('one unhealthy required job is reported by name', () => {
    const jobs = allHealthy();
    jobs.retention = healthy({ successMinutesAgo: 5000, maxAgeMinutes: 1800 });
    expect(unhealthyJobsFrom(jobs)).toEqual(['retention']);
  });

  it('each job is graded against ITS OWN contract limit, not a shared one', () => {
    // retention tolerates 1800 minutes, reminders 360. A 400-minute-old
    // retention success is healthy; a 400-minute-old reminders success is not.
    const jobs = allHealthy();
    jobs.retention = healthy({ successMinutesAgo: 400, maxAgeMinutes: 1800 });
    jobs.reminders = healthy({ successMinutesAgo: 400 });
    expect(unhealthyJobsFrom(jobs)).toEqual(['reminders']);
  });
});
