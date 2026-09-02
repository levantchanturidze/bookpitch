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
  // `outboxFailed` is deliberately NOT counted as a job failure, and getting
  // this wrong would have been worse than leaving it out. A send that fails is
  // retried with exponential backoff and dead-lettered after max_attempts —
  // that is the outbox's own state machine, and the alarm for mail that never
  // lands is `outbox-dead-letters`, which already exists. Treating a single
  // undeliverable address as a housekeeping failure would 500 this endpoint
  // every hour, forever, for one bounced message.
  //
  // What housekeeping is responsible for is COMPLETING the sweep. Units are
  // the messages it actually delivered, reported for visibility. If
  // runHousekeeping() itself throws, the route 500s without reaching here.
  // Three states, and the middle one is the reason this is not a one-liner:
  //
  //   empty sweep            nothing to send. SUCCESS — it completed.
  //   delivery failures      routine. The outbox retries with backoff and
  //                          dead-letters; `outbox-dead-letters` is the alarm.
  //                          NOT counted here — one undeliverable address must
  //                          not fail the hourly job forever.
  //   infrastructure failure the sweep did not RUN: provider init threw, or
  //                          claim/recovery/sweep failed. FAILURE. This used to
  //                          return zeroes and be indistinguishable from an
  //                          empty queue, so a total inability to send mail
  //                          wrote a successful heartbeat and answered 200.
  const infraFailed = result.outboxInfraFailed ?? 0;
  const outcome = await recordCronHeartbeat('housekeeping', {
    expected: (result.outboxSent ?? 0) + infraFailed,
    processed: result.outboxSent ?? 0,
    failed: infraFailed,
  });
  const status = outcome === 'success' ? 200 : 500;
  return NextResponse.json({ ok: outcome === 'success', outcome, ...result }, { status });
}
