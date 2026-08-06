import type { NextRequest } from 'next/server';
import { withApi, InvalidInputError } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { confirmTotpEnrollment } from '@/lib/platform/mfa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/platform/mfa/confirm
// Body: { code }
// Verifies the first TOTP code after enrollment, activating MFA.
// SUPER_ADMIN only.
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'platform.role.assign', undefined, 'platform');
    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) throw new InvalidInputError('code is required');
    await confirmTotpEnrollment(ctx.userId, code);
    return { ok: true };
  });
}
