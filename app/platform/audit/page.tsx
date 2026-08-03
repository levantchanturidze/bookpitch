import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { queryPlatformAudit } from '@/lib/platform/audit';
import { unsafePrismaAdmin } from '@/lib/db';
import AuditView from '@/components/platform/AuditView';

export const metadata = { title: 'Audit · Platform' };
export const dynamic = 'force-dynamic';

export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAuthContext();
  requirePermission(ctx, 'platform.audit.read', undefined, 'platform');

  const sp = await searchParams;
  const s = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '') || null;

  const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { id: ctx.userId },
    select: { platformRole: { select: { key: true } } },
  });
  const maskPii = user.platformRole?.key === 'SUPPORT_AGENT';

  const rows = await queryPlatformAudit({
    actorUserId: s('actor'),
    organizationId: s('org'),
    action: s('action'),
    fromDate: s('from') ? new Date(s('from')!) : null,
    toDate: s('to') ? new Date(s('to')!) : null,
    limit: 200,
  }, { maskPii });

  return <AuditView rows={rows} maskPii={maskPii} initial={{
    actor: s('actor') ?? '', org: s('org') ?? '', action: s('action') ?? '',
    from: s('from') ?? '', to: s('to') ?? '',
  }} />;
}
