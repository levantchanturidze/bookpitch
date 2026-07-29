import { requireAuthContext, requirePermission } from '@/lib/rbac';
import NewOrgForm from '@/components/platform/NewOrgForm';

export const metadata = { title: 'New organization · Platform' };
export const dynamic = 'force-dynamic';

// Spec §6.1 row 1: SUPER_ADMIN + PLATFORM_ADMIN. `platform.org.create` is
// checked here (page-level) so a caller without permission gets 403 before
// the form even renders, and again in POST /api/platform/orgs.
export default async function NewOrgPage() {
  const ctx = await requireAuthContext();
  requirePermission(ctx, 'platform.org.create', undefined, 'platform');
  return <NewOrgForm />;
}
