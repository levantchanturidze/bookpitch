import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withoutRls } from '@/lib/db';
import { runReminderTick } from '@/lib/messaging/reminders';

// POST /api/cron/reminders
//
// Public but bearer-auth'd via CRON_SECRET. Intended to be called by an
// external scheduler (Vercel Cron, GitHub Actions workflow, systemd timer).
// Iterates every organization and sends any due reminders. Idempotent per
// (appointment, channel) — safe to run every few minutes.
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
    tx.organization.findMany({ select: { id: true } }),
  );
  const reports = await Promise.all(orgs.map((o) => runReminderTick(o.id)));
  return NextResponse.json({ orgs: reports.length, reports });
}
