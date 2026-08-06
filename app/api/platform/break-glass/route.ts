import type { NextRequest } from 'next/server';
import { withApi, InvalidInputError } from '@/lib/auth';
import { requireAuthContext } from '@/lib/rbac';
import { startBreakGlass } from '@/lib/platform/break-glass';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/platform/break-glass
// Body: { password, totpCode, reason, ticketId, targetOrganizationId? }
//
// SUPER_ADMIN only (enforced inside startBreakGlass). Not using
// withPlatformApi because activation is a mutation, not a read.
// Spec §7.2 rule 3: password + TOTP both required.
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const body = (await req.json().catch(() => ({}))) as {
      password?: unknown; totpCode?: unknown; reason?: unknown;
      ticketId?: unknown; targetOrganizationId?: unknown;
    };
    const password = typeof body.password === 'string' ? body.password : '';
    const totpCode = typeof body.totpCode === 'string' ? body.totpCode : '';
    const reason = typeof body.reason === 'string' ? body.reason : '';
    const ticketId = typeof body.ticketId === 'string' ? body.ticketId : '';
    const targetOrganizationId = typeof body.targetOrganizationId === 'string'
      ? body.targetOrganizationId : null;
    if (!password || !totpCode || !reason || !ticketId) {
      throw new InvalidInputError('password, totpCode, reason, ticketId are required');
    }
    const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip');
    const userAgent = req.headers.get('user-agent');
    return startBreakGlass({
      actor: ctx, password, totpCode, reason, ticketId, targetOrganizationId, ip, userAgent,
    });
  });
}
