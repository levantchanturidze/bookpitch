import type { NextRequest } from 'next/server';
import { withApi } from '@/lib/auth';
import { requireAuthContext } from '@/lib/rbac';
import { endBreakGlass } from '@/lib/platform/break-glass';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason : 'user_end';
    return endBreakGlass(ctx, reason);
  });
}
