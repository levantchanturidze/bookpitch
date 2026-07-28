import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ctxToSession, InvalidInputError } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { buildClaimsExport, renderClaimsCsv } from '@/lib/insurance';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/insurance/export?from=YYYY-MM-DD&to=YYYY-MM-DD&insurer=<name>
//
// Returns a CSV attachment ready to submit to the named insurer (or all
// insurers when omitted). Missing/invalid dates → 400.
//
// Not wrapped in withApi because we return text/csv, not JSON.
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'report.export', { organizationId: ctx.activeOrganizationId! }, 'insurance');
    const session = ctxToSession(ctx);
    const url = new URL(req.url);
    const fromStr = url.searchParams.get('from') ?? '';
    const toStr = url.searchParams.get('to') ?? '';
    if (!fromStr || !toStr) throw new InvalidInputError('from + to are required');
    const from = new Date(fromStr);
    const to = new Date(toStr);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new InvalidInputError('from and to must be ISO dates');
    }
    // `to` is inclusive to end-of-day, matching /audit convention.
    const toExclusive = new Date(to.getTime() + 24 * 3600 * 1000);
    const insurer = url.searchParams.get('insurer') || null;

    const rows = await buildClaimsExport(session, { from, to: toExclusive, insurer });
    const csv = renderClaimsCsv(rows);
    log.info('insurance.export.ok', { rows: rows.length, insurer });

    const filename = `claims-${fromStr}-to-${toStr}${insurer ? `-${slug(insurer)}` : ''}.csv`;
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof InvalidInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
