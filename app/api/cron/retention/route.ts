import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withoutRls } from '@/lib/db';
import { runRetentionTick } from '@/lib/gdpr';
import { cronOrgConcurrency, mapWithConcurrency } from '@/lib/concurrency';
import { log } from '@/lib/logger';

// POST /api/cron/retention
//
// Bearer-auth'd via CRON_SECRET (same shape as /api/cron/reminders).
// Iterates every org and anonymizes customers whose PII has been idle
// past the org's customer_retention_years window. Safe to run daily.
//
// P17-005: bounded fan-out, same reasoning as /api/cron/reminders. This one
// matters more if anything: a retention tick anonymizes rows, and losing the
// report for organizations that had already run — which `Promise.all` does the
// moment any org throws — means the operator cannot tell what was processed.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    log.error('cron.retention.org_limit_hit', { limit: MAX_ORGS_PER_RUN });
  }

  const concurrency = cronOrgConcurrency();
  const settled = await mapWithConcurrency(batch, concurrency, (o) => runRetentionTick(o.id));

  const reports = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  const failures = settled.flatMap((s, i) =>
    s.status === 'rejected' ? [{ organizationId: batch[i].id, error: s.reason }] : [],
  );
  for (const f of failures) {
    log.error('cron.retention.org_failed', f);
  }

  return NextResponse.json({
    orgs: reports.length,
    concurrency,
    totalAnonymized: reports.reduce((n, r) => n + r.anonymizedCount, 0),
    ...(truncated ? { truncated: true, limit: MAX_ORGS_PER_RUN } : {}),
    ...(failures.length ? { failed: failures.length, failures } : {}),
    reports,
  });
}
