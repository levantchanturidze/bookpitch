import type { NextRequest } from 'next/server';
import { withApi } from '@/lib/auth';
import { requireAuthContext } from '@/lib/rbac';
import { endImpersonation } from '@/lib/platform/impersonation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/platform/impersonate/end — ends the caller's own active
// impersonation session. No platform.* permission required — the caller
// must have an active session, which is proof enough they're entitled to
// end it. Not using withPlatformApi because we don't want to log this as
// a break-glass read (it's a control action).
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason : 'user_end';
    return endImpersonation(ctx, reason);
  });
}
