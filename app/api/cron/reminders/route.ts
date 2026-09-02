import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withoutRls } from '@/lib/db';
import { runReminderTick } from '@/lib/messaging/reminders';
import { cronOrgConcurrency, mapWithConcurrency } from '@/lib/concurrency';
import { log } from '@/lib/logger';
import { recordCronHeartbeat } from '@/lib/cron-heartbeat';

// POST /api/cron/reminders
//
// Public but bearer-auth'd via CRON_SECRET. Intended to be called by an
// external scheduler (Vercel Cron, GitHub Actions workflow, systemd timer).
// Iterates every organization and sends any due reminders. Idempotent per
// (appointment, channel) — safe to run every few minutes.
//
// P17-005: the fan-out is bounded. This used to be
// `Promise.all(orgs.map(runReminderTick))` over an unlimited findMany, which
// starts every organization at once against a pool capped at PG_POOL_MAX
// (default 3) and discards every successful report the moment one org throws.
// See lib/concurrency.ts.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ceiling on organizations handled in one invocation. Deliberately far above
 * the current tenant count: this is a blast-radius bound and an alarm, not a
 * paging scheme. Taking a fixed prefix of an ordered list means organizations
 * past the limit would never be reached at all, so hitting it is a real
 * incident — shard the schedule — and it is logged at error level.
 */
const MAX_ORGS_PER_RUN = Math.max(1, Number(process.env.CRON_MAX_ORGS_PER_RUN ?? 500));

export async function POST(req: NextRequest) {
  const provided = req.headers.get('authorization');
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const orgs = await withoutRls((tx) =>
    tx.organization.findMany({
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_ORGS_PER_RUN + 1,
    }),
  );
  const truncated = orgs.length > MAX_ORGS_PER_RUN;
  const batch = truncated ? orgs.slice(0, MAX_ORGS_PER_RUN) : orgs;
  if (truncated) {
    log.error('cron.reminders.org_limit_hit', { limit: MAX_ORGS_PER_RUN });
  }

  const concurrency = cronOrgConcurrency();
  const settled = await mapWithConcurrency(batch, concurrency, (o) => runReminderTick(o.id));

  const reports = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  const failures = settled.flatMap((s, i) =>
    s.status === 'rejected' ? [{ organizationId: batch[i].id, error: s.reason }] : [],
  );
  for (const f of failures) {
    log.error('cron.reminders.org_failed', f);
  }

  // Application-side proof of what the tick DID, as opposed to the GitHub
  // Actions run list's proof that it was invoked.
  //
  // This used to pass `reports.length` — the count of organizations that
  // happened to succeed — into an unconditional success write. A tick in which
  // every organization threw wrote a fresh `last_succeeded_at` with units 0,
  // and the monitor reported a healthy job. `truncated` counts too: taking a
  // fixed prefix of an ordered list means organizations past the limit are
  // never reached, which is not a completed tick.
  const outcome = await recordCronHeartbeat('reminders', {
    expected: orgs.length,
    processed: reports.length,
    failed: failures.length,
  });

  // A cron endpoint that returns 200 after failing its work is the reason the
  // workflow run list was never trustworthy evidence. 500 so the workflow step
  // fails too, and the failure is visible in three places instead of none.
  const status = outcome === 'success' ? 200 : 500;

  return NextResponse.json(
    {
      ok: outcome === 'success',
      outcome,
      // `orgs` is fetched with take: MAX + 1, so when truncated this exceeds
      // what was processed and the run is classified partial — which is
      // correct: organizations past the limit were never reached.
      expected: orgs.length,
      orgs: reports.length,
      concurrency,
      ...(truncated ? { truncated: true, limit: MAX_ORGS_PER_RUN } : {}),
      ...(failures.length ? { failed: failures.length, failures } : {}),
      reports,
    },
    { status },
  );
}
