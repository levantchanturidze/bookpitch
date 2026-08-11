import type { NextRequest } from 'next/server';
import { withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withOrgReplica } from '@/lib/db';
import { queryAudit, type AuditRow } from '@/lib/audit-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function escapeCell(v: unknown): string {
  const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toRow(r: AuditRow): string {
  return [
    r.at,
    r.actorEmail ?? '',
    r.action,
    r.entity,
    r.entityId ?? '',
    r.customerName ?? '',
    r.meta != null ? JSON.stringify(r.meta) : '',
  ]
    .map(escapeCell)
    .join(',');
}

// GET /api/audit/export?customer=&actor=&action=&entity=&from=&to=
// Returns a CSV download of the org's audit log (up to 5000 rows).
export async function GET(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'audit.read', { organizationId: ctx.activeOrganizationId! }, 'audit');

    const sp = req.nextUrl.searchParams;
    const s = (k: string) => sp.get(k)?.trim() || null;

    const rows = await withOrgReplica(ctx.activeOrganizationId!, (tx) =>
      queryAudit(tx, {
        customerId: s('customer'),
        actorUserId: s('actor'),
        action: s('action'),
        entity: s('entity'),
        fromDate: s('from') ? new Date(s('from')!) : null,
        toDate: s('to') ? new Date(new Date(s('to')!).getTime() + 24 * 3600_000 - 1) : null,
        limit: 5000,
      }),
    );

    const header = 'timestamp,actor_email,action,entity,entity_id,customer_name,meta';
    const csv = [header, ...rows.map(toRow)].join('\r\n');
    const date = new Date().toISOString().slice(0, 10);

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-${date}.csv"`,
      },
    });
  });
}
