import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { classifyRun, recordCronHeartbeat } from '@/lib/cron-heartbeat';
import { collectOpsMetrics } from '@/lib/ops-metrics';
import { unsafePrismaAdmin } from '@/lib/db';
import { evaluateOpsMetrics, OPS_DERIVED_CHECK_IDS } from '../scripts/production-monitor.mjs';

// -----------------------------------------------------------------------------
// A cron job must not be able to fail its work and still look healthy.
//
// The first version of the heartbeat could, in three independent ways at once:
//
//   * the reminders route called recordCronHeartbeat('reminders', reports.length)
//     AFTER logging per-organization failures. A tick in which all ten
//     organizations threw wrote a fresh last_succeeded_at with units 0;
//   * the route returned 200 regardless, so the workflow step passed;
//   * the monitor checked only the AGE of the heartbeat, so a job attempted
//     every 15 minutes and failing every time was indistinguishable from a
//     healthy quiet period for the whole six-hour limit.
//
// Three signals, all reporting health, none of them measuring whether the work
// happened. The comment above that call even claimed "a run where every org
// threw must not look like a healthy tick" — which the code did not do.
//
// The other half is the clock. Timestamps came from `new Date()`, the Node
// clock, so a serverless instance with skew could write a heartbeat from the
// future and keep a dead job alive indefinitely. Every other age in this
// project is taken from the database.
// -----------------------------------------------------------------------------

describe('classifyRun refuses to call incomplete work a success', () => {
  it('everything processed, nothing failed → success', () => {
    expect(classifyRun({ expected: 10, processed: 10, failed: 0 })).toBe('success');
  });

  it('nothing to do → success, because it did complete', () => {
    expect(classifyRun({ expected: 0, processed: 0, failed: 0 })).toBe('success');
  });

  it('THE REGRESSION: every unit failed → failure, not success-with-zero-units', () => {
    expect(classifyRun({ expected: 10, processed: 0, failed: 10 })).toBe('failure');
  });

  it('some processed, some failed → partial', () => {
    expect(classifyRun({ expected: 10, processed: 7, failed: 3 })).toBe('partial');
  });

  it('silently short → partial, even with no explicit failures', () => {
    // Truncation: organizations past MAX_ORGS_PER_RUN are never reached, so
    // nothing "fails" and the work is still not done.
    expect(classifyRun({ expected: 500, processed: 200, failed: 0 })).toBe('partial');
  });

  it('processed nothing and expected something → failure', () => {
    expect(classifyRun({ expected: 5, processed: 0, failed: 0 })).toBe('failure');
  });
});

describe('the heartbeat uses the database clock and only advances on success', () => {
  afterEach(async () => {
    await unsafePrismaAdmin.$executeRawUnsafe(
      `DELETE FROM cron_heartbeat WHERE job IN ('reminders','housekeeping')`,
    );
  });

  it('a success stamps the DATABASE clock, not the process clock', async () => {
    await recordCronHeartbeat('reminders', { expected: 3, processed: 3, failed: 0 });
    const rows = await unsafePrismaAdmin.$queryRawUnsafe<
      Array<{ skew_seconds: number; outcome: string }>
    >(
      `SELECT EXTRACT(EPOCH FROM (NOW() - last_succeeded_at))::float AS skew_seconds,
              last_outcome AS outcome
         FROM cron_heartbeat WHERE job = 'reminders'`,
    );
    expect(rows[0].outcome).toBe('success');
    // Written by NOW() inside the statement, so it is within a breath of the
    // database's own clock regardless of what the Node process believes.
    expect(Math.abs(rows[0].skew_seconds)).toBeLessThan(5);
  });

  it('THE REGRESSION: a failed run does NOT advance last_succeeded_at', async () => {
    await recordCronHeartbeat('reminders', { expected: 10, processed: 10, failed: 0 });
    const before = await successAt('reminders');

    // Ten organizations, all of them threw. Under the old code this wrote a
    // fresh success with units 0.
    const outcome = await recordCronHeartbeat('reminders', {
      expected: 10,
      processed: 0,
      failed: 10,
    });
    expect(outcome).toBe('failure');

    const after = await successAt('reminders');
    expect(after, 'a failure must not move the success timestamp').toBe(before);
  });

  it('a partial run does not advance it either', async () => {
    await recordCronHeartbeat('reminders', { expected: 10, processed: 10, failed: 0 });
    const before = await successAt('reminders');
    expect(await recordCronHeartbeat('reminders', { expected: 10, processed: 6, failed: 4 })).toBe(
      'partial',
    );
    expect(await successAt('reminders')).toBe(before);
  });

  it('records the attempt even when it did not succeed', async () => {
    // "attempted and failed" must be distinguishable from "never attempted".
    await recordCronHeartbeat('housekeeping', { expected: 4, processed: 1, failed: 3 });
    const rows = await unsafePrismaAdmin.$queryRawUnsafe<
      Array<{ outcome: string; attempted: Date | null; expected: number; failed: number }>
    >(
      `SELECT last_outcome AS outcome, last_attempted_at AS attempted,
              last_expected_units AS expected, last_failed_units AS failed
         FROM cron_heartbeat WHERE job = 'housekeeping'`,
    );
    expect(rows[0].outcome).toBe('partial');
    expect(rows[0].attempted).not.toBeNull();
    expect(Number(rows[0].expected)).toBe(4);
    expect(Number(rows[0].failed)).toBe(3);
  });

  it('the ops endpoint reports the outcome, not just the age', async () => {
    await recordCronHeartbeat('reminders', { expected: 10, processed: 0, failed: 10 });
    const m = await collectOpsMetrics();
    expect(m.cronHeartbeat.remindersLastOutcome).toBe(-1); // failure
    expect(m.cronHeartbeat.remindersExpectedUnits).toBe(10);
    expect(m.cronHeartbeat.remindersFailedUnits).toBe(10);
    expect(m.cronHeartbeat.jobsNotSucceeding).toBeGreaterThan(0);
    // Never succeeded, so there is no success age to report.
    expect(m.cronHeartbeat.remindersMinutesAgo).toBeNull();
  });
});

async function successAt(job: string): Promise<string | null> {
  const rows = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ t: Date | null }>>(
    `SELECT last_succeeded_at AS t FROM cron_heartbeat WHERE job = $1`,
    job,
  );
  const t = rows[0]?.t;
  return t ? new Date(t).toISOString() : null;
}

// -----------------------------------------------------------------------------
// The monitor side.
// -----------------------------------------------------------------------------
describe('the monitor cannot report a failing job as healthy', () => {
  const check = (cronHeartbeat: Record<string, number | null>, id = 'cron-heartbeat-stale') =>
    evaluateOpsMetrics({ config: {}, cronHeartbeat }).find((r: { id: string }) => r.id === id);

  it('THE REGRESSION: a fresh FAILURE fails, even though nothing is stale yet', () => {
    // The job was attempted a minute ago and failed. Under an age-only check
    // the last success is still recent, so this reported healthy.
    const r = check({
      remindersMinutesAgo: 20,
      remindersLastUnits: 0,
      remindersLastOutcome: -1,
      remindersExpectedUnits: 10,
      remindersFailedUnits: 10,
      remindersAttemptMinutesAgo: 1,
    });
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/FAILED/);
    expect(r!.detail).toMatch(/0 of 10 organization\(s\) processed, 10 failed/);
  });

  it('a fresh PARTIAL fails too', () => {
    const r = check({
      remindersMinutesAgo: 20,
      remindersLastUnits: 6,
      remindersLastOutcome: 0,
      remindersExpectedUnits: 10,
      remindersFailedUnits: 4,
      remindersAttemptMinutesAgo: 2,
    });
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/PARTIALLY FAILED/);
  });

  it('a recent success passes', () => {
    const r = check({
      remindersMinutesAgo: 20,
      remindersLastUnits: 10,
      remindersLastOutcome: 1,
      remindersExpectedUnits: 10,
      remindersFailedUnits: 0,
      remindersAttemptMinutesAgo: 20,
    });
    expect(r!.ok).toBe(true);
    expect(r!.detail).toMatch(/last succeeded 0\.3h ago/);
  });

  it('a stale success still fails, outcome notwithstanding', () => {
    const r = check({
      remindersMinutesAgo: 9 * 60,
      remindersLastUnits: 10,
      remindersLastOutcome: 1,
      remindersExpectedUnits: 10,
      remindersFailedUnits: 0,
      remindersAttemptMinutesAgo: 9 * 60,
    });
    expect(r!.ok).toBe(false);
  });

  it('a deployment predating outcome tracking keeps the age-only behaviour', () => {
    const r = check({
      remindersMinutesAgo: 20,
      remindersLastUnits: 10,
      remindersLastOutcome: null,
    });
    expect(r!.ok).toBe(true);
    expect(r!.detail).toMatch(/predates outcome tracking/);
  });

  it('the per-job checks are registered against monitor blindness', () => {
    expect(OPS_DERIVED_CHECK_IDS).toContain('cron-heartbeat-stale');
    for (const job of ['reminders', 'housekeeping', 'retention', 'audit-digest']) {
      expect(OPS_DERIVED_CHECK_IDS).toContain(`cron-job-${job}`);
    }
  });
});

// -----------------------------------------------------------------------------
// The monitor side of §6. The database side — that the count actually moves
// when an appointment is missed, and does not when one was booked inside its
// own lead window — is in tests/reminder-gap-recovery.test.ts.
// -----------------------------------------------------------------------------
describe('the monitor surfaces a reminder that can never be sent', () => {
  const check = (cronHeartbeat: Record<string, number | null>) =>
    evaluateOpsMetrics({ config: {}, cronHeartbeat }).find(
      (r: { id: string }) => r.id === 'reminders-missed',
    );

  it('fails when an appointment started unreminded', () => {
    // Every other signal can be green here: fresh heartbeat, successful cron
    // run, green workflow — and a customer was not reminded. This is counted
    // from the appointments themselves rather than inferred from job health.
    const r = check({ unremindedStartedAppointments: 3 });
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/cannot be retried/);
  });

  it('passes at zero', () => {
    expect(check({ unremindedStartedAppointments: 0 })!.ok).toBe(true);
  });

  it('is omitted rather than green on a deployment predating the metric', () => {
    expect(
      evaluateOpsMetrics({ config: {} }).find((r: { id: string }) => r.id === 'reminders-missed'),
    ).toBeUndefined();
  });

  it('is registered against monitor blindness', () => {
    expect(OPS_DERIVED_CHECK_IDS).toContain('reminders-missed');
  });
});

// -----------------------------------------------------------------------------
// The boundary between "the job failed" and "a message failed".
//
// Getting this wrong is a self-inflicted outage: a single undeliverable address
// among the outbox rows would 500 the hourly housekeeping endpoint forever.
// The outbox retries with exponential backoff and dead-letters after
// max_attempts, and `outbox-dead-letters` is the alarm for mail that never
// lands. Housekeeping is responsible for completing the sweep, not for
// guaranteeing every recipient exists.
// -----------------------------------------------------------------------------
describe('a failed message is not a failed job', () => {
  it('housekeeping does not count outbox send failures against itself', () => {
    const src = readFileSync(
      path.resolve(__dirname, '..', 'app', 'api', 'cron', 'housekeeping', 'route.ts'),
      'utf8',
    );
    // Delivery failures must not reach the heartbeat's `failed` count…
    expect(src).not.toMatch(/failed: result\.outboxFailed/);
    expect(src).toMatch(/outbox-dead-letters/);
    // …but a failure to RUN the sweep must. Those are different things, and
    // collapsing them either way is a bug: counting delivery failures 500s the
    // hourly job on one bad address, and ignoring infra failures makes a total
    // inability to send mail look like an empty queue.
    expect(src).toMatch(/failed: infraFailed/);
    expect(src).toMatch(/outboxInfraFailed/);
  });

  it('a drain that delivered nothing is still a completed sweep', () => {
    // An empty queue is not a failure.
    expect(classifyRun({ expected: 0, processed: 0, failed: 0 })).toBe('success');
  });

  it('COMPLEMENT: dead letters are still surfaced, by their own check', () => {
    const r = evaluateOpsMetrics({
      config: {},
      outbox: { dead: 2, pending: 0, processing: 0, staleClaims: 0, deadLast24h: 2 },
    }).find((x: { id: string }) => x.id === 'outbox-dead-letters');
    expect(r!.ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// §8 — every required job evaluated on its own, against its own cadence.
//
// The previous aggregate counted rows that already existed with a
// partial/failure outcome. Three ways that read green while a job was dead:
//
//   * a job that had NEVER written a heartbeat had no row, so it counted 0;
//   * a row still at outcome 'unknown' was explicitly excluded;
//   * only reminders had a freshness gate, so retention could stop for a week
//     and the count stayed zero.
//
// Four reminder runs prove nothing about retention, housekeeping or the digest.
// -----------------------------------------------------------------------------
describe('each required job is evaluated individually', () => {
  const job = (over: Record<string, number | null> = {}) => ({
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
  const jobsCheck = (jobs: Record<string, unknown>, name: string) =>
    evaluateOpsMetrics({ config: {}, cronHeartbeat: { jobs } }).find(
      (r: { id: string }) => r.id === `cron-job-${name}`,
    );
  const allHealthy = () => ({
    reminders: job(),
    housekeeping: job(),
    retention: job({ maxAgeMinutes: 1800 }),
    auditDigest: job({ maxAgeMinutes: 1800 }),
  });

  it('every required job gets its own check', () => {
    const results = evaluateOpsMetrics({ config: {}, cronHeartbeat: { jobs: allHealthy() } });
    for (const name of ['reminders', 'housekeeping', 'retention', 'audit-digest']) {
      expect(results.find((r: { id: string }) => r.id === `cron-job-${name}`)).toBeDefined();
    }
  });

  it('THE REGRESSION: a job that has NEVER run fails', () => {
    // No row at all. The old scalar counted zero and reported healthy.
    const r = jobsCheck({ ...allHealthy(), retention: job({ present: 0 }) }, 'retention');
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/has not completed once/);
  });

  it("THE REGRESSION: an 'unknown' outcome is NOT VERIFIED, not a pass", () => {
    const r = jobsCheck({ ...allHealthy(), housekeeping: job({ outcome: null }) }, 'housekeeping');
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/NOT VERIFIED/);
  });

  it('THE REGRESSION: retention stale for a week fails on its own cadence', () => {
    // Reminders can be perfectly healthy throughout.
    const jobs = {
      ...allHealthy(),
      retention: job({ successMinutesAgo: 7 * 24 * 60, maxAgeMinutes: 1800 }),
    };
    expect(jobsCheck(jobs, 'retention')!.ok).toBe(false);
    expect(jobsCheck(jobs, 'reminders')!.ok, 'reminders is unaffected').toBe(true);
  });

  it('a failed or partial outcome fails, with the unit arithmetic', () => {
    const failed = jobsCheck(
      {
        ...allHealthy(),
        reminders: job({ outcome: -1, processedUnits: 0, failedUnits: 10, expectedUnits: 10 }),
      },
      'reminders',
    );
    expect(failed!.ok).toBe(false);
    expect(failed!.detail).toMatch(/FAILED — 0 of 10 units, 10 failed/);

    const partial = jobsCheck(
      {
        ...allHealthy(),
        reminders: job({ outcome: 0, processedUnits: 6, failedUnits: 4, expectedUnits: 10 }),
      },
      'reminders',
    );
    expect(partial!.ok).toBe(false);
    expect(partial!.detail).toMatch(/PARTIALLY FAILED/);
  });

  it('an incoherent success — fewer units processed than expected — fails', () => {
    // Whatever the stored outcome says. A "success" that did 2 of 10 is not one.
    const r = jobsCheck(
      { ...allHealthy(), housekeeping: job({ outcome: 1, processedUnits: 2, expectedUnits: 10 }) },
      'housekeeping',
    );
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/reports success but processed 2 of 10/);
  });

  it('a success with no success timestamp fails', () => {
    const r = jobsCheck(
      { ...allHealthy(), reminders: job({ successMinutesAgo: null }) },
      'reminders',
    );
    expect(r!.ok).toBe(false);
  });

  it('all four healthy passes', () => {
    for (const name of ['reminders', 'housekeeping', 'retention', 'audit-digest']) {
      expect(jobsCheck(allHealthy(), name)!.ok, `${name} should be healthy`).toBe(true);
    }
  });

  it('a deployment reporting only the old scalar is NOT VERIFIED', () => {
    // Not green. The scalar cannot distinguish "never ran" from "healthy", so
    // trusting it would reinstate exactly what this replaced.
    const r = evaluateOpsMetrics({
      config: {},
      cronHeartbeat: { jobsNotSucceeding: 0 },
    }).find((x: { id: string }) => x.id === 'cron-jobs-failing');
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/cannot distinguish "never ran" from "healthy"/);
  });
});
