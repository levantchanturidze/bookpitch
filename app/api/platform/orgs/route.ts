import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';
import { listOrganizations } from '@/lib/platform/orgs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/platform/orgs — every platform role can list. SUPPORT_AGENT
// sees the same row shape (aggregate counts, no customer PII).
export async function GET() {
  return withPlatformApi('org.list', async (ctx) => {
    requirePermission(ctx, 'platform.analytics.read', undefined, 'platform');
    const orgs = await listOrganizations();
    return { orgs };
  });
}
