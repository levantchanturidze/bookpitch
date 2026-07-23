import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { runHousekeeping } from '@/lib/housekeeping';

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
  return NextResponse.json({ ok: true, ...result });
}
