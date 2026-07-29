import type { NextRequest } from 'next/server';
import { ctxToSession, withApi, InvalidInputError } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { nominateTransfer, pendingTransfersForNominee } from '@/lib/admin/ownership-transfer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/admin/ownership-transfer — nominee's inbox. Session-only —
// any signed-in user can see transfers addressed to them, gated by
// requireAuthContext.
export async function GET() {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const rows = await pendingTransfersForNominee(ctx.userId);
    return { transfers: rows };
  });
}

// POST /api/admin/ownership-transfer  { toUserId }
// Nominate a new owner. Requires org.ownership.transfer (owner-only).
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'org.ownership.transfer', { organizationId: ctx.activeOrganizationId! }, 'admin');
    const body = (await req.json().catch(() => ({}))) as { toUserId?: unknown };
    const toUserId = typeof body.toUserId === 'string' ? body.toUserId : '';
    if (!toUserId) throw new InvalidInputError('toUserId is required');
    return nominateTransfer(ctxToSession(ctx), toUserId);
  });
}
