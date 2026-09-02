import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { runDigestForAllOrgs } from '@/lib/audit-digest';
import { recordCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/cron/audit-digest
// Bearer CRON_SECRET. Runs hourly (and weekly); runDigestForAllOrgs() is
// idempotent per ISO week, so extra invocations are no-ops.
//
// Delivery is gated by AUDIT_DIGEST_ENABLED and is OFF by default. While
// disabled this returns 200 with skipped:true and touches nothing — the job is
// intentionally paused, not failing, and reporting it as a cron failure would
// bury genuine cron faults under known noise. The paused state is surfaced by
// the production monitor's audit-digest check instead.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const result = await runDigestForAllOrgs();
  // Proof of completion, not merely of invocation. Written even when delivery
  // is gated off: the job DID run and correctly did nothing, which is a very
  // different state from the job never running at all.
  await recordCronHeartbeat('audit-digest', typeof result.orgs === 'number' ? result.orgs : 0);
  return NextResponse.json({ ok: true, ...result });
}
