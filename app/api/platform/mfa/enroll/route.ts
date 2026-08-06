import { withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { generateTotpEnrollment } from '@/lib/platform/mfa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/platform/mfa/enroll
// SUPER_ADMIN only. Generates a new TOTP secret, encrypts and stores it
// (pending confirmation), and returns the otpauth URI for QR rendering.
// Call POST /api/platform/mfa/confirm with the first code to activate.
export async function POST() {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'platform.role.assign', undefined, 'platform');
    return generateTotpEnrollment(ctx.userId);
  });
}
