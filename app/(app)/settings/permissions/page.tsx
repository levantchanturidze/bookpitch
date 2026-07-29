import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission, loadOrgToggles } from '@/lib/rbac';
import PermissionsPanel from '@/components/settings/PermissionsPanel';

export const metadata = { title: 'Permissions · Bookpitch' };
export const dynamic = 'force-dynamic';

// Owner-facing per-org toggles (spec §6.2 ⚙️ cells). Delegated to a
// client component so the individual switches are interactive.
export default async function PermissionsPage() {
  const ctx = await requireAuthContext();
  requirePermission(ctx, 'org.settings.update:org', { organizationId: ctx.activeOrganizationId! }, 'admin');
  void ctxToSession(ctx); // ensure org-plane session; guard also does this
  const toggles = await loadOrgToggles(ctx.activeOrganizationId!);
  return <PermissionsPanel initial={toggles} />;
}
