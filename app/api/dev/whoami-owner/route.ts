import { requireRole, withApi } from '@/lib/auth';

/**
 * Sample owner-only endpoint used by the RBAC test in P1.2.
 * The real API routes land in P1.4 / P1.5. This exists purely to verify the
 * requireRole() guard is enforced server-side.
 */
export async function GET() {
  return withApi(async () => {
    const session = await requireRole('owner');
    return { ok: true, session };
  });
}
