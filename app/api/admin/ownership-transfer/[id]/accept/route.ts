import type { NextRequest } from 'next/server';
import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext } from '@/lib/rbac';
import { acceptTransfer } from '@/lib/admin/ownership-transfer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/admin/ownership-transfer/[id]/accept — nominee accepts.
// Roles swap in a single tx. Both parties' sessionVersions bump.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const { id } = await params;
    return acceptTransfer(ctxToSession(ctx), id);
  });
}
