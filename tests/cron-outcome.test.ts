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

  it('any job failing is surfaced, not just reminders', () => {
    // housekeeping DRAINS the email outbox: a failing housekeeping run means
    // queued mail is reaching nobody.
    const r = check({ jobsNotSucceeding: 2 }, 'cron-jobs-failing');
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/2 job\(s\)/);
  });

  it('COMPLEMENT: zero failing jobs passes', () => {
    expect(check({ jobsNotSucceeding: 0 }, 'cron-jobs-failing')!.ok).toBe(true);
  });

  it('both new checks are registered against monitor blindness', () => {
    expect(OPS_DERIVED_CHECK_IDS).toContain('cron-heartbeat-stale');
    expect(OPS_DERIVED_CHECK_IDS).toContain('cron-jobs-failing');
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
    // The heartbeat call must not pass outboxFailed through as `failed`.
    expect(src).toMatch(/failed: 0,/);
    expect(src).not.toMatch(/failed: result\.outboxFailed/);
    expect(src).toMatch(/outbox-dead-letters/);
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
