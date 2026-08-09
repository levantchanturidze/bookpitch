import type { NextRequest } from 'next/server';
import { withApi, InvalidInputError } from '@/lib/auth';
import { requireAuthContext } from '@/lib/rbac';
import { startBreakGlass } from '@/lib/platform/break-glass';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/platform/break-glass
// Body: { password, totpCode | recoveryCode, reason, ticketId, targetOrganizationId? }
//
// SUPER_ADMIN only (enforced inside startBreakGlass). Not using
// withPlatformApi because activation is a mutation, not a read.
// Spec §7.2 rule 3: password + 2FA both required.
// 2FA may be a TOTP code (totpCode) or a single-use recovery code (recoveryCode).
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const body = (await req.json().catch(() => ({}))) as {
      password?: unknown;
      totpCode?: unknown;
      recoveryCode?: unknown;
      reason?: unknown;
      ticketId?: unknown;
      targetOrganizationId?: unknown;
    };
    const password = typeof body.password === 'string' ? body.password : '';
    const totpCode = typeof body.totpCode === 'string' ? body.totpCode : undefined;
    const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode : undefined;
    const reason = typeof body.reason === 'string' ? body.reason : '';
    const ticketId = typeof body.ticketId === 'string' ? body.ticketId : '';
    const targetOrganizationId =
      typeof body.targetOrganizationId === 'string' ? body.targetOrganizationId : null;
    if (!password || (!totpCode && !recoveryCode) || !reason || !ticketId) {
      throw new InvalidInputError(
        'password, (totpCode or recoveryCode), reason, ticketId are required',
      );
    }
    const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip');
    const userAgent = req.headers.get('user-agent');
    return startBreakGlass({
      actor: ctx,
      password,
      totpCode,
      recoveryCode,
      reason,
      ticketId,
      targetOrganizationId,
      ip,
      userAgent,
    });
  });
}
