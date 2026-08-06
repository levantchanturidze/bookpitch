import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withOrgReplica } from '@/lib/db';
import { queryAudit } from '@/lib/audit-query';
import AuditView from '@/components/audit/AuditView';

export const metadata = { title: 'Audit log · Bookpitch' };
export const dynamic = 'force-dynamic';

// Owner-only. Filters come in as query params; the client component pushes
// changes back into the URL so filter state survives reload + is shareable.
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAuthContext();
  requirePermission(ctx, 'audit.read', { organizationId: ctx.activeOrganizationId! }, 'audit');
  const session = ctxToSession(ctx);
  const sp = await searchParams;
  const s = (k: string) =>
    typeof sp[k] === 'string' && (sp[k] as string).trim().length > 0 ? (sp[k] as string) : '';

  const customer = s('customer');
  const actor = s('actor');
  const action = s('action');
  const entity = s('entity');
  const from = s('from');
  const to = s('to');

  const rows = await withOrgReplica(session.organizationId, (tx) =>
    queryAudit(tx, {
      customerId: customer || null,
      actorUserId: actor || null,
      action: action || null,
      entity: entity || null,
      fromDate: from ? new Date(from) : null,
      // `to` is inclusive to the end of day.
      toDate: to ? new Date(new Date(to).getTime() + 24 * 3600_000 - 1) : null,
      limit: 200,
    }),
  );

  return <AuditView rows={rows} initial={{ customer, actor, action, entity, from, to }} />;
}
