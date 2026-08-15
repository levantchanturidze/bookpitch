import type { NextRequest } from 'next/server';
import { withApi, InvalidInputError } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { confirmTotpEnrollment } from '@/lib/platform/mfa';
import { requireFreshPassword } from '@/lib/platform/password-reauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/platform/mfa/confirm
// Body: { code }
// Verifies the first TOTP code after enrollment, activating MFA.
// SUPER_ADMIN only. Requires a fresh password grant with purpose
// 'platform.mfa.confirm' — a separate grant from the enroll step so that
// each step is independently verified and individually single-use.
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'platform.role.assign', undefined, 'platform');
    if (!ctx.authSessionId) throw new InvalidInputError('session identifier missing — re-sign in');
    await requireFreshPassword(ctx.userId, ctx.authSessionId, 'platform.mfa.confirm');
    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) throw new InvalidInputError('code is required');
    const { recoveryCodes } = await confirmTotpEnrollment(ctx.userId, code);
    // recoveryCodes is non-null only for initial enrollment — show once, never again.
    return { ok: true, recoveryCodes };
  });
}
