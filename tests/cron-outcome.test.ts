import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { classifyRun, recordCronHeartbeat } from '@/lib/cron-heartbeat';
import { collectOpsMetrics } from '@/lib/ops-metrics';
import { unsafePrismaAdmin } from '@/lib/db';
import {
  HEARTBEAT_JOBS,
  HEARTBEAT_MAX_AGE_MINUTES,
  HEARTBEAT_METRIC_KEY,
} from '@/lib/cron-heartbeat-jobs';
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
    (
      evaluateOpsMetrics({ config: {}, cronHeartbeat }) as Array<{
        id: string;
        ok: boolean;
        detail: string;
        // Present on checks competent to raise an alarm but not to declare it
        // over — see the reminders-missed empty-window rule.
        canClose?: boolean;
      }>
    ).find((r: { id: string }) => r.id === 'reminders-missed');

  it('fails when an appointment started unreminded', () => {
    // Every other signal can be green here: fresh heartbeat, successful cron
    // run, green workflow — and a customer was not reminded. This is counted
    // from the appointments themselves rather than inferred from job health.
    const r = check({ unremindedStartedAppointments: 3, eligibleStartedAppointments: 9 });
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/cannot be retried/);
    expect(r!.detail).toMatch(/3 of 9/);
  });

  it('passes at zero missed, WHEN something was actually measured', () => {
    const r = check({ unremindedStartedAppointments: 0, eligibleStartedAppointments: 7 });
    expect(r!.ok).toBe(true);
    // RECOVERY MUST REMAIN POSSIBLE. A `canClose: false` welded permanently to
    // this check would make #90 unclosable by any evidence, which is the
    // opposite failure to the one being fixed — an incident that can never
    // recover is as useless as one that recovers on nothing. The flag is
    // conditional on the window actually holding a sample.
    expect(r!.canClose).toBe(true);
  });

  it('a single owed-and-delivered appointment is enough to permit closure', () => {
    // The minimum viable recovery evidence, which is what the post-Stage-D
    // sentinel will produce: one appointment owed a reminder, and it arrived.
    const r = check({ unremindedStartedAppointments: 0, eligibleStartedAppointments: 1 });
    expect(r!.ok).toBe(true);
    expect(r!.canClose).toBe(true);
    expect(r!.detail).toMatch(/0 of 1/);
  });

  it('a sample that exists but MISSED keeps the incident open', () => {
    const r = check({ unremindedStartedAppointments: 1, eligibleStartedAppointments: 1 });
    expect(r!.ok).toBe(false);
    // Failing checks never close anything regardless of the flag; asserted so
    // a future refactor cannot make a red check closable.
    expect(r!.ok && r!.canClose).toBeFalsy();
  });

  // ---------------------------------------------------------------------------
  // INCIDENT #90, second defect: zero missed is not the same as zero of zero.
  //
  // #90 closed itself on 2026-09-17 with the comment "0 appointment(s) in the
  // last 48h". Nothing had recovered — its single failing appointment had aged
  // out of the rolling window, the count fell 1 -> 0, and the monitor read the
  // absence of evidence as evidence of health. The defect was still live in
  // production, and still is until the reminder-policy release ships.
  // ---------------------------------------------------------------------------
  it('does NOT pass when the window held nothing to measure', () => {
    const r = check({ unremindedStartedAppointments: 0, eligibleStartedAppointments: 0 });
    expect(r!.ok, 'an empty window is not health').toBe(false);
    expect(r!.detail).toMatch(/NOT VERIFIED/);
  });

  it('can NEVER close an incident on an empty window', () => {
    // The property that actually stops the false closure. Even if some future
    // change made an empty window read green again, `canClose: false` keeps it
    // from declaring an incident over.
    const r = check({ unremindedStartedAppointments: 0, eligibleStartedAppointments: 0 });
    expect(r!.canClose).toBe(false);
  });

  it('refuses to conclude when the deployment reports no denominator', () => {
    // A build predating the denominator cannot tell 0-of-0 from 0-of-7, so it
    // says so rather than guessing in the optimistic direction.
    const r = check({ unremindedStartedAppointments: 0 });
    expect(r!.ok).toBe(false);
    expect(r!.canClose).toBe(false);
    expect(r!.detail).toMatch(/denominator/i);
  });

  it('still fails on a genuine miss even when most reminders landed', () => {
    // The complement of the empty-window rule: adding a denominator must not
    // dilute a real failure into an acceptable ratio.
    const r = check({ unremindedStartedAppointments: 1, eligibleStartedAppointments: 50 });
    expect(r!.ok).toBe(false);
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

// -----------------------------------------------------------------------------
// The monitor grades jobs against a contract it holds itself
// (EXPECTED_HEARTBEAT_JOBS in scripts/production-monitor.mjs) rather than
// against the limits production reports. That contract has to mirror
// lib/cron-heartbeat-jobs.ts, and it cannot import it: the monitor is `.mjs`
// and this is TypeScript, which Node will not load from a `.mjs` module. That
// exact assumption already shipped once as `await import('../lib/sentry-
// receipt.ts')` — it type-checked, passed every test, and would have thrown on
// its first real run.
//
// So the duplication is deliberate, and this is what stops it drifting.
// -----------------------------------------------------------------------------
describe('the monitor’s job contract mirrors the application’s', () => {
  it('same jobs, same metric keys, same limits', async () => {
    const { EXPECTED_HEARTBEAT_JOBS } = await import('../scripts/production-monitor.mjs');

    const fromApp = HEARTBEAT_JOBS.map((job) => ({
      metricKey: HEARTBEAT_METRIC_KEY[job],
      checkId: `cron-job-${job}`,
      maxAgeMinutes: HEARTBEAT_MAX_AGE_MINUTES[job],
    }));

    expect(
      [...EXPECTED_HEARTBEAT_JOBS].sort((a, b) => a.metricKey.localeCompare(b.metricKey)),
      'scripts/production-monitor.mjs::EXPECTED_HEARTBEAT_JOBS has drifted from ' +
        'lib/cron-heartbeat-jobs.ts',
    ).toEqual(fromApp.sort((a, b) => a.metricKey.localeCompare(b.metricKey)));
  });
});
