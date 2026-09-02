import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { runHousekeeping } from '@/lib/housekeeping';
import { recordCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/cron/housekeeping
//
// Same auth model as /api/cron/reminders: bearer CRON_SECRET. Safe to run
// hourly; work scales with the number of stale rows, not with tenant count.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const result = await runHousekeeping();
  // Proof of what the run DID, not merely that it was invoked.
  //
  // The units are the outbox rows housekeeping attempted to DELIVER — this is
  // the job that drains email_outbox. outboxFailed is a real failure: those
  // messages reached nobody. Summing every numeric field, as this used to,
  // made pruned rate-limit rows cancel out failed deliveries.
  const outcome = await recordCronHeartbeat('housekeeping', {
    expected: (result.outboxSent ?? 0) + (result.outboxFailed ?? 0),
    processed: result.outboxSent ?? 0,
    failed: result.outboxFailed ?? 0,
  });
  const status = outcome === 'success' ? 200 : 500;
  return NextResponse.json({ ok: outcome === 'success', outcome, ...result }, { status });
}
