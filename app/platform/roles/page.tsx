import { requireAuthContext, requirePagePermission, perm } from '@/lib/rbac';
import { listPlatformRoleHolders } from '@/lib/platform/roles';
import PlatformRolesPanel from '@/components/platform/PlatformRolesPanel';

export const metadata = { title: 'Platform roles · Platform' };
export const dynamic = 'force-dynamic';

// Any platform user can view the roster (accountability). Assignment is
// gated separately on the API (SUPER_ADMIN only via platform.role.assign).
// The UI still passes canAssign to the client so the form is hidden for
// non-SUPER users — UI-hide + server-side deny.
export default async function PlatformRolesPage() {
  const ctx = await requireAuthContext();
  requirePagePermission(ctx, 'platform.audit.read', undefined, 'platform');
  const holders = await listPlatformRoleHolders();
  const canAssign = ctx.platformPermissions.has(perm('platform.role.assign'));
  return (
    <PlatformRolesPanel
      holders={holders.map((h) => ({ ...h, assignedAt: h.assignedAt?.toISOString() ?? null }))}
      canAssign={canAssign}
    />
  );
}
