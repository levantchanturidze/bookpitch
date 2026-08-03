import type { NextRequest } from 'next/server';
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';
import { InvalidInputError, NotFoundError } from '@/lib/auth';
import { getOrganization, editOrganization } from '@/lib/platform/orgs';
import { requireFreshPassword } from '@/lib/platform/password-reauth';

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

// PATCH — F-08 fix. Edits a subset of org attributes. SUPER_ADMIN +
// PLATFORM_ADMIN via `platform.org.suspend` (both mutate org state).
// allowSupportImpersonation flip requires a fresh password (spec §9
// rule 9 — anything that changes support-access policy is destructive-
// tier and needs re-auth).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withPlatformApi('org.edit', async (ctx) => {
    requirePermission(ctx, 'platform.org.suspend', undefined, 'platform');
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as {
      name?: unknown; vertical?: unknown; allowSupportImpersonation?: unknown;
    } | null;
    if (!body) throw new InvalidInputError('invalid body');
    const patch: Parameters<typeof editOrganization>[2] = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (typeof body.vertical === 'string' || body.vertical === null) {
      patch.vertical = body.vertical as never;
    }
    if (typeof body.allowSupportImpersonation === 'boolean') {
      patch.allowSupportImpersonation = body.allowSupportImpersonation;
      // Any change to support-access policy needs a fresh password.
      requireFreshPassword(ctx.userId);
    }
    return { org: await editOrganization(ctx, id, patch) };
  });
}
