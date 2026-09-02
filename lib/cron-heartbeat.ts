import { unsafePrismaAdmin, withoutRls } from '@/lib/db';
import { log } from '@/lib/logger';
import type { HeartbeatJob } from '@/lib/cron-heartbeat-jobs';

export { HEARTBEAT_JOBS, type HeartbeatJob } from '@/lib/cron-heartbeat-jobs';

// -----------------------------------------------------------------------------
// The application's own statement about what a cron job actually DID.
//
// Everything the monitor knew about cron health came from the GitHub Actions
// runs list: "a workflow was queued and its curl exited 0". That is a fact
// about GitHub, not about Bookpitch. It stays green if the endpoint returns
// 200 having done nothing, and it disappears entirely if the scheduler is
// replaced.
//
// TWO THINGS THIS GOT WRONG FIRST TIME, both of which made it another healthy
// signal that meant nothing:
//
//   1. It timestamped with `new Date()` — the Node clock. A serverless
//      instance with a skewed clock could write a heartbeat from the future
//      and keep a dead job looking alive indefinitely. Every other age in this
//      project is taken from the database for exactly this reason.
//
//   2. It recorded SUCCESS unconditionally. The reminders route called it
//      after logging per-organization failures, passing the count of
//      organizations that happened to succeed — so a tick where all ten
//      organizations threw wrote a fresh `last_succeeded_at` with `units = 0`
//      and the monitor reported a healthy job. The comment above the call
//      even claimed "a run where every org threw must not look like a healthy
//      tick", which the code did not do.
//
// So the heartbeat now records an OUTCOME and the unit arithmetic behind it,
// and `last_succeeded_at` only moves when the outcome is a success.
// -----------------------------------------------------------------------------

export type CronOutcome = 'success' | 'partial' | 'failure';

export type CronRunResult = {
  /** Units the run was supposed to handle (organizations, rows, …). */
  expected: number;
  /** Units it actually completed. */
  processed: number;
  /** Units that failed. */
  failed: number;
};

/**
 * Classify a run from its unit arithmetic.
 *
 * Deliberately strict: anything short of "everything expected was processed
 * and nothing failed" is not a success. A job with nothing to do (expected 0)
 * is a success — it did complete.
 */
export function classifyRun({ expected, processed, failed }: CronRunResult): CronOutcome {
  if (failed > 0 || processed < expected) return processed > 0 ? 'partial' : 'failure';
  return 'success';
}

/**
 * Record the outcome of a cron run.
 *
 * NEVER throws. A heartbeat is telemetry: failing the cron run because the
 * bookkeeping write failed would turn an observability feature into an outage,
 * and the run has already done its real work by the time this is called. A
 * write failure is logged and the heartbeat simply goes stale — which is the
 * honest outcome, and what the monitor then reports.
 */
export async function recordCronHeartbeat(
  job: HeartbeatJob,
  result: CronRunResult,
): Promise<CronOutcome> {
  const outcome = classifyRun(result);
  const expected = Math.max(0, Math.trunc(result.expected));
  const processed = Math.max(0, Math.trunc(result.processed));
  const failed = Math.max(0, Math.trunc(result.failed));

  try {
    // NOW() is the DATABASE clock, and the write is raw SQL for that reason:
    // Prisma would send a JS Date, which is the Node clock, which is the bug
    // this replaces. `last_succeeded_at` advances ONLY on a success; on a
    // partial or failed run the previous success timestamp is preserved, so
    // the monitor keeps ageing from the last time the job genuinely worked.
    await withoutRls(
      () =>
        unsafePrismaAdmin.$executeRaw`
        INSERT INTO cron_heartbeat
          (job, last_succeeded_at, last_units, last_outcome, last_attempted_at,
           last_expected_units, last_failed_units)
        VALUES
          (${job},
           CASE WHEN ${outcome} = 'success' THEN NOW() ELSE NULL END,
           ${processed}, ${outcome}, NOW(), ${expected}, ${failed})
        ON CONFLICT (job) DO UPDATE SET
          last_succeeded_at   = CASE WHEN ${outcome} = 'success'
                                     THEN NOW()
                                     ELSE cron_heartbeat.last_succeeded_at END,
          last_units          = ${processed},
          last_outcome        = ${outcome},
          last_attempted_at   = NOW(),
          last_expected_units = ${expected},
          last_failed_units   = ${failed}
      `,
    );
  } catch (err) {
    log.error('cron.heartbeat_write_failed', {
      job,
      outcome,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
  return outcome;
}
