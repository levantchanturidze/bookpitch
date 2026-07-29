import type { NextRequest } from 'next/server';
import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext } from '@/lib/rbac';
import { revokeTransfer } from '@/lib/admin/ownership-transfer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DELETE /api/admin/ownership-transfer/[id] — nominator revokes their
// own pending nomination. No requirePermission — the service enforces
// that only the fromUser can revoke.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const { id } = await params;
    return revokeTransfer(ctxToSession(ctx), id);
  });
}
