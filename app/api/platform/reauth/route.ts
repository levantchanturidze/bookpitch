import type { NextRequest } from 'next/server';
import { withApi, InvalidInputError } from '@/lib/auth';
import { requireAuthContext } from '@/lib/rbac';
import { verifyPasswordFresh } from '@/lib/platform/password-reauth';
import { isReauthPurpose } from '@/lib/platform/reauth-purpose';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/platform/reauth  { password, purpose, orgId? }
//
// Client-side pattern for destructive actions (spec §9 rule 9):
//   1. UI prompts for the password before showing a destructive confirmation.
//   2. POST here with the specific purpose — creates a session/purpose-bound
//      single-use grant that expires in 60s.
//   3. Client immediately POSTs the destructive action; the route calls
//      requireFreshPassword(ctx.userId, ctx.authSessionId, purpose, { orgId })
//      which atomically consumes the grant.
//
// The purpose must be an allowlisted value from ReauthPurpose. Client supplies
// the purpose so the server can create a grant for exactly the intended action.
// A grant created for 'platform.mfa.enroll' cannot satisfy 'platform.org.suspend'.
//
// Wrong passwords return InvalidInputError (400) so the client can display
// "bad password" vs. "session expired" (401) distinctly.
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const body = (await req.json().catch(() => ({}))) as {
      password?: unknown;
      purpose?: unknown;
      orgId?: unknown;
    };

    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) throw new InvalidInputError('password is required');

    const purpose = body.purpose;
    if (!isReauthPurpose(purpose)) {
      throw new InvalidInputError('purpose must be one of the allowed reauth purposes');
    }

    const orgId = typeof body.orgId === 'string' && body.orgId ? body.orgId : undefined;

    // authSessionId is the stable JWT claim bound to this login session.
    // It is never supplied by the client — always sourced from the verified JWT.
    const authSessionId = ctx.authSessionId;
    if (!authSessionId) {
      throw new InvalidInputError('session identifier missing — re-sign in');
    }

    await verifyPasswordFresh(ctx.userId, password, authSessionId, purpose, {
      throwOnBadPassword: true,
      orgId,
    });

    return { ok: true };
  });
}
