import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { runDigestForAllOrgs } from '@/lib/audit-digest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/cron/audit-digest
// Bearer CRON_SECRET. Meant to be called weekly. Emails a 7-day audit
// rollup to every owner in every org.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const result = await runDigestForAllOrgs();
  return NextResponse.json({ ok: true, ...result });
}
