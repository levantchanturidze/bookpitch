import type { NextRequest } from 'next/server';
import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext } from '@/lib/rbac';
import { declineTransfer } from '@/lib/admin/ownership-transfer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/admin/ownership-transfer/[id]/decline — nominee declines.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason : 'declined';
    return declineTransfer(ctxToSession(ctx), id, reason);
  });
}
