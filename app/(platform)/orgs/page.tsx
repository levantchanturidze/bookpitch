import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { listOrganizations } from '@/lib/platform/orgs';
import OrgList from '@/components/platform/OrgList';

export const metadata = { title: 'Organizations · Platform' };
export const dynamic = 'force-dynamic';

export default async function PlatformOrgsPage() {
  const ctx = await requireAuthContext();
  requirePermission(ctx, 'platform.analytics.read', undefined, 'platform');
  const orgs = await listOrganizations();
  return <OrgList orgs={orgs.map(o => ({ ...o, createdAt: o.createdAt.toISOString() }))} />;
}
