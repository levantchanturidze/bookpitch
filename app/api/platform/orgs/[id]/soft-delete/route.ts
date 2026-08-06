import type { NextRequest } from 'next/server';
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';
import { InvalidInputError } from '@/lib/auth';
import { softDeleteOrganization } from '@/lib/platform/orgs';
import { requireFreshPassword } from '@/lib/platform/password-reauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// SUPER_ADMIN only (platform.org.delete is granted only to SUPER_ADMIN).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformApi('org.soft_delete', async (ctx) => {
    requirePermission(ctx, 'platform.org.delete', undefined, 'platform');
    const { id } = await params;
    // Spec §9 rule 9: requires a session/purpose/org-bound fresh-password grant.
    // Grant must specify purpose='platform.org.delete' and orgId=id.
    await requireFreshPassword(ctx.userId, ctx.authSessionId, 'platform.org.delete', { orgId: id });
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (!reason) throw new InvalidInputError('reason is required');
    return { org: await softDeleteOrganization(ctx, id, reason) };
  });
}
