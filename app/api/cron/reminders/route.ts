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

  // Channel-level accounting, not organization-level.
  //
  // This used to count an organization as processed whenever runReminderTick()
  // resolved. It resolves normally when every provider send fails —
  // sendForAppointment() returns a report rather than throwing — and when the
  // appointment list was truncated. So a tick in which nothing reached anyone
  // was ten successful organizations, HTTP 200, and a healthy heartbeat.
  const tallies = reports.map((r) => r.tally);
  const sum = (k: keyof (typeof tallies)[number]) => tallies.reduce((n, t) => n + (t[k] ?? 0), 0);

  const channelsExpected = sum('channelsExpected');
  const sent = sum('sent');
  const duplicates = sum('duplicates');
  const missingContact = sum('missingContact');
  const rateLimited = sum('rateLimited');
  const providerFailed = sum('providerFailed');
  const unprocessed = sum('unprocessed');

  // A duplicate is a valid outcome — the reminder already went out. A missing
  // contact is valid too: there is no address to send to, which is a data state
  // rather than a delivery failure. Provider failures, rate limiting and
  // unprocessed work are not.
  const settledChannels = sent + duplicates + missingContact;
  const failedChannels = providerFailed + rateLimited;

  const outcome = await recordCronHeartbeat('reminders', {
    // Organizations that threw outright are counted as unreached channels, so a
    // thrown org cannot vanish from the arithmetic.
    expected: channelsExpected + failures.length,
    processed: settledChannels,
    failed: failedChannels + failures.length + unprocessed,
  });

  // Anything short of success is a non-2xx, so the workflow step fails too.
  const status = outcome === 'success' ? 200 : 500;

  return NextResponse.json(
    {
      ok: outcome === 'success',
      outcome,
      orgs: reports.length,
      orgsFailed: failures.length,
      concurrency,
      // Counts only. Raw provider errors and any appointment or address detail
      // stay server-side: this response is read by CI logs and the monitor.
      channels: {
        expected: channelsExpected,
        sent,
        duplicates,
        missingContact,
        rateLimited,
        providerFailed,
        unprocessed,
      },
      ...(truncated ? { truncated: true, limit: MAX_ORGS_PER_RUN } : {}),
    },
    { status },
  );
}
