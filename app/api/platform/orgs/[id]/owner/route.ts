import type { NextRequest } from 'next/server';
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';
import { InvalidInputError } from '@/lib/auth';
import { changeOrganizationOwner } from '@/lib/platform/orgs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformApi('org.owner.change', async (ctx) => {
    requirePermission(ctx, 'platform.org.owner.change', undefined, 'platform');
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { newOwnerEmail?: unknown };
    const email = typeof body.newOwnerEmail === 'string' ? body.newOwnerEmail : '';
    if (!email) throw new InvalidInputError('newOwnerEmail is required');
    return changeOrganizationOwner(ctx, id, email);
  });
}
