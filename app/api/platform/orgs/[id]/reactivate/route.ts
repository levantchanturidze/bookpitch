import type { NextRequest } from 'next/server';
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';
import { reactivateOrganization } from '@/lib/platform/orgs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformApi('org.reactivate', async (ctx) => {
    // Same perm as suspend — the action is the inverse. No password
    // re-auth required (spec §9 rule 9 is destructive-only).
    requirePermission(ctx, 'platform.org.suspend', undefined, 'platform');
    const { id } = await params;
    return { org: await reactivateOrganization(ctx, id) };
  });
}
