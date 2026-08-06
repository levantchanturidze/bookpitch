import type { NextRequest } from 'next/server';
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';
import { InvalidInputError } from '@/lib/auth';
import { suspendOrganization } from '@/lib/platform/orgs';
import { requireFreshPassword } from '@/lib/platform/password-reauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformApi('org.suspend', async (ctx) => {
    requirePermission(ctx, 'platform.org.suspend', undefined, 'platform');
    // Spec §9 rule 9: destructive actions require password re-entry.
    await requireFreshPassword(ctx.userId);
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (!reason) throw new InvalidInputError('reason is required');
    return { org: await suspendOrganization(ctx, id, reason) };
  });
}
