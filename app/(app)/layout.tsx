import { redirect } from 'next/navigation';
import Shell from '@/components/shell/Shell';
import { UnauthenticatedError } from '@/lib/auth';
import { requireAuthContext, can } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { loadLocationsForOrg } from '@/lib/active-location';
import { NAV_ITEMS } from '@/components/shell/nav-items';

/**
 * Layout for every authed route. Middleware guarantees a session exists;
 * requireAuthContext() here is a redundant safety net that also builds
 * the AuthContext once, so per-request `can()` calls (nav visibility) hit
 * the 30s in-process cache instead of the DB.
 *
 * The client Shell receives `visibleNavIds` — a pre-computed Set of nav
 * ids the caller has permission to see. Shell greys out entries not in
 * the set. Route-level guards enforce independently on click.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let ctx;
  try {
    ctx = await requireAuthContext();
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect('/signin');
    throw err;
  }
  if (!ctx.activeOrganizationId) redirect('/signin');
  const orgId = ctx.activeOrganizationId;

  const [organization, { locations, active }] = await Promise.all([
    withOrg(orgId, (tx) =>
      tx.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
    ),
    loadLocationsForOrg(orgId), // redirects to /signin if empty
  ]);

  if (!organization) redirect('/signin');

  const visibleNavIds = new Set(
    NAV_ITEMS.filter((item) =>
      can(ctx, item.requiredPermission, { organizationId: orgId }),
    ).map((item) => item.id),
  );

  return (
    <Shell
      session={{
        email: ctx.email,
        organizationId: orgId,
        roleDisplay: ctx.roleKey ?? '',
      }}
      organizationName={organization.name}
      locations={locations}
      activeLocation={active}
      visibleNavIds={visibleNavIds}
    >
      {children}
    </Shell>
  );
}
