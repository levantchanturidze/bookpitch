import { withoutRls } from '@/lib/db';
import { log } from '@/lib/logger';

// -----------------------------------------------------------------------------
// The application's own statement that a cron job ran to completion.
//
// Everything the monitor knew about cron health came from the GitHub Actions
// runs list: "a workflow was queued and its curl exited 0". That is a fact
// about GitHub, not about Bookpitch. It stays green if the endpoint returns
// 200 having done nothing, and it disappears entirely if the scheduler is ever
// replaced.
//
// The gap that matters is between INVOCATION and COMPLETION. This closes it
// from the application side, so `cron-staleness` (did the schedule arrive?)
// and `cron-heartbeat-stale` (did the work actually happen?) are separate
// questions with separate answers.
// -----------------------------------------------------------------------------

export { HEARTBEAT_JOBS, type HeartbeatJob } from './cron-heartbeat-jobs';
import type { HeartbeatJob } from './cron-heartbeat-jobs';

/**
 * Record that `job` finished successfully, having handled `units` of work.
 *
 * NEVER throws. A heartbeat is telemetry: failing the cron run because the
 * bookkeeping write failed would turn an observability feature into an
 * outage, and the run has already done its real work by the time this is
 * called. A failure is logged and the heartbeat simply goes stale, which is
 * the honest outcome — the monitor then reports "no recent completion", which
 * is exactly what happened.
 */
export async function recordCronHeartbeat(job: HeartbeatJob, units: number): Promise<void> {
  try {
    await withoutRls((tx) =>
      tx.cronHeartbeat.upsert({
        where: { job },
        // The clock is the DATABASE's, not the runtime's. A serverless
        // instance with a skewed clock would otherwise be able to write a
        // heartbeat from the future and keep a dead job looking alive.
        create: { job, lastSucceededAt: new Date(), lastUnits: Math.max(0, Math.trunc(units)) },
        update: { lastSucceededAt: new Date(), lastUnits: Math.max(0, Math.trunc(units)) },
      }),
    );
  } catch (err) {
    log.error('cron.heartbeat_write_failed', {
      job,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}
