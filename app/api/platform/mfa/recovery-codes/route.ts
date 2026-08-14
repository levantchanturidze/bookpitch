import { withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { generateRecoveryCodes, getRemainingRecoveryCodeCount } from '@/lib/platform/mfa';
import { requireFreshPassword } from '@/lib/platform/password-reauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/platform/mfa/recovery-codes
//
// Returns the count of unused recovery codes for the authenticated SUPER_ADMIN.
// No plaintext codes are returned — count only. Does not require a fresh
// password grant (non-destructive read).
//
// Cache-Control: no-store — prevents caching of sensitive account metadata.
export async function GET() {
  const res = await withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'platform.role.assign', undefined, 'platform');
    const remaining = await getRemainingRecoveryCodeCount(ctx.userId);
    return { remaining };
  });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

// POST /api/platform/mfa/recovery-codes
//
// Regenerates the full set of recovery codes. Invalidates all existing codes
// (used and unused) and creates RECOVERY_CODE_COUNT fresh ones.
//
// Requires a fresh password grant with purpose 'platform.mfa.recovery_codes'
// to prevent an attacker with a stolen session from invalidating existing codes
// and reading the new ones.
//
// The response body contains plaintext codes exactly once. After this call,
// the codes are hashed in the database and cannot be retrieved again.
// The client MUST display and allow the user to copy/download the codes.
//
// Cache-Control: no-store — plaintext codes must never be cached by any proxy,
// CDN, or browser cache.
export async function POST() {
  const res = await withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'platform.role.assign', undefined, 'platform');
    if (!ctx.authSessionId) throw new Error('session identifier missing — re-sign in');
    await requireFreshPassword(ctx.userId, ctx.authSessionId, 'platform.mfa.recovery_codes');
    const result = await generateRecoveryCodes(ctx.userId);
    return { codes: result.codes };
  });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
