import type { NextRequest } from 'next/server';
import { withPlatformApi } from '@/lib/platform/api';
import { requirePermission } from '@/lib/rbac';
import { InvalidInputError } from '@/lib/auth';
import { startImpersonation } from '@/lib/platform/impersonation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/platform/impersonate { organizationId, targetUserId, reason, ticketId }
export async function POST(req: NextRequest) {
  return withPlatformApi('impersonation.start', async (ctx) => {
    requirePermission(ctx, 'platform.impersonate', undefined, 'platform');
    const body = (await req.json().catch(() => ({}))) as {
      organizationId?: unknown;
      targetUserId?: unknown;
      reason?: unknown;
      ticketId?: unknown;
    };
    const organizationId = typeof body.organizationId === 'string' ? body.organizationId : '';
    const targetUserId = typeof body.targetUserId === 'string' ? body.targetUserId : '';
    const reason = typeof body.reason === 'string' ? body.reason : '';
    const ticketId = typeof body.ticketId === 'string' ? body.ticketId : '';
    if (!organizationId || !targetUserId || !reason || !ticketId) {
      throw new InvalidInputError(
        'organizationId, targetUserId, reason, ticketId are all required',
      );
    }
    const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip');
    const userAgent = req.headers.get('user-agent');
    return startImpersonation({
      actor: ctx,
      targetUserId,
      organizationId,
      reason,
      ticketId,
      ip,
      userAgent,
    });
  });
}
