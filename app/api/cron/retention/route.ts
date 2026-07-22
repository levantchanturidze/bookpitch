import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withoutRls } from '@/lib/db';
import { runRetentionTick } from '@/lib/gdpr';

// POST /api/cron/retention
//
// Bearer-auth'd via CRON_SECRET (same shape as /api/cron/reminders).
// Iterates every org and anonymizes customers whose PII has been idle
// past the org's customer_retention_years window. Safe to run daily.
export async function POST(req: NextRequest) {
  const provided = req.headers.get('authorization');
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const orgs = await withoutRls((tx) => tx.organization.findMany({ select: { id: true } }));
  const reports = await Promise.all(orgs.map((o) => runRetentionTick(o.id)));
  return NextResponse.json({
    orgs: reports.length,
    totalAnonymized: reports.reduce((n, r) => n + r.anonymizedCount, 0),
    reports,
  });
}
