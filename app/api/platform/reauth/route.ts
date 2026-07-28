import type { NextRequest } from 'next/server';
import { withApi, InvalidInputError } from '@/lib/auth';
import { requireAuthContext } from '@/lib/rbac';
import { verifyPasswordFresh } from '@/lib/platform/password-reauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/platform/reauth  { password }
//
// Client-side pattern for destructive actions (spec §9 rule 9):
//   1. UI prompts the caller for their password before showing a
//      destructive control's confirmation dialog.
//   2. POST here — sets a 60-second "fresh" marker on the caller's
//      userId in memory (lib/platform/password-reauth.ts).
//   3. Client immediately POSTs the destructive action; the route
//      calls requireFreshPassword(ctx.userId) which reads the marker.
//
// Wrong passwords return 400 (not 403) so the client can differentiate
// "bad password" from "session gone".
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const body = (await req.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) throw new InvalidInputError('password is required');
    await verifyPasswordFresh(ctx.userId, password, { throwOnBadPassword: true });
    return { ok: true };
  });
}
