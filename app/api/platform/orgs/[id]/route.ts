import type { NextRequest } from 'next/server';
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';
import { NotFoundError } from '@/lib/auth';
import { getOrganization } from '@/lib/platform/orgs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformApi('org.detail', async (ctx) => {
    requirePermission(ctx, 'platform.analytics.read', undefined, 'platform');
    const { id } = await params;
    const org = await getOrganization(id);
    if (!org) throw new NotFoundError('organization not found');
    return { org };
  });
}
