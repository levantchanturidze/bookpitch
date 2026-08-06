import type { NextRequest } from 'next/server';
import { requireSession, withApi, InvalidInputError } from '@/lib/auth';
import { switchActiveOrg } from '@/lib/org-switch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/session/switch  { organizationId }
 *
 * Phase 3 flow:
 *   1. Server verifies the caller belongs to `organizationId` and bumps
 *      their sessionVersion (invalidates the current JWT within ~5s).
 *   2. Response includes `requireReSignIn: true` — the client follows up
 *      with `signIn('credentials', { orgId })` (Auth.js) to mint a fresh
 *      JWT bound to the new org.
 *
 * The frontend is what actually completes the switch; this endpoint just
 * authorises the request and clears the old session.
 */
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireSession();
    const body = (await req.json().catch(() => null)) as { organizationId?: unknown } | null;
    const organizationId = typeof body?.organizationId === 'string' ? body.organizationId : '';
    if (!organizationId) throw new InvalidInputError('organizationId is required');
    await switchActiveOrg(session.userId, organizationId);
    return { ok: true, organizationId, requireReSignIn: true };
  });
}
