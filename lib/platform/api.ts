// -----------------------------------------------------------------------------
// RBAC Phase 5 — thin wrapper for platform route handlers.
//
// Composes lib/auth::withApi + the break-glass read-audit hook. Every
// platform route uses this instead of plain withApi so that spec §7.2
// rule 6 ("reads are audited, not only writes") is automatically
// satisfied when the caller is inside an active break-glass session.
//
// Usage:
//
//   export async function GET() {
//     return withPlatformApi('org.list', async (ctx) => {
//       // ctx is a resolved AuthContext with platform.* permissions loaded.
//       return { orgs: await listOrganizations() };
//     });
//   }
//
// The action label is written into the audit row's `action` column,
// prefixed with `break_glass.read.` — see auditBreakGlassRead. Pick
// a stable string per endpoint (`org.list`, `org.detail`, `audit.query`).
// -----------------------------------------------------------------------------

import type { NextResponse } from 'next/server';
import { withApi } from '@/lib/auth';
import { requireAuthContext } from '@/lib/rbac';
import type { AuthContext } from '@/lib/rbac';
import { auditBreakGlassRead } from './break-glass';

export function withPlatformApi<T>(
  action: string,
  handler: (ctx: AuthContext) => Promise<T>,
): Promise<NextResponse> {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const body = await handler(ctx);
    if (ctx.isBreakGlass) {
      await auditBreakGlassRead(ctx, action).catch(() => {
        // Never let an audit-write failure change the response — logged
        // by prisma internals; the request already succeeded from the
        // caller's perspective. Prefer a lost audit row over a false
        // 500 that hides the actual outcome.
      });
    }
    return body;
  });
}
