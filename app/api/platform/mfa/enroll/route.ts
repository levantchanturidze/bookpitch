import { withApi, InvalidInputError } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { generateTotpEnrollment } from '@/lib/platform/mfa';
import { requireFreshPassword } from '@/lib/platform/password-reauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/platform/mfa/enroll
// SUPER_ADMIN only. Generates a new TOTP secret, encrypts and stores it
// (pending confirmation), and returns the otpauth URI for QR rendering.
// Call POST /api/platform/mfa/confirm with the first code to activate.
//
// Requires a fresh password grant with purpose 'platform.mfa.enroll'. The
// grant must have been created by POST /api/platform/reauth in the same
// login session. This prevents a compromised session without the password
// from enrolling or replacing a TOTP secret.
//
// Cache-Control: no-store — the response contains the plaintext TOTP secret
// which must never be cached by any proxy, CDN, or browser.
export async function POST() {
  const res = await withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'platform.role.assign', undefined, 'platform');
    if (!ctx.authSessionId) throw new InvalidInputError('session identifier missing — re-sign in');
    await requireFreshPassword(ctx.userId, ctx.authSessionId, 'platform.mfa.enroll');
    return generateTotpEnrollment(ctx.userId);
  });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
