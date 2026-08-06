import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';

/**
 * Sample endpoint used by the RBAC test suite to verify the guard is
 * enforced server-side. Requires a permission that only owners hold by
 * default (`org.settings.update:org`), so a receptionist/provider hitting
 * this endpoint gets 403.
 */
export async function GET() {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'org.settings.update:org',
      { organizationId: ctx.activeOrganizationId! },
      'dev',
    );
    return { ok: true, session: ctxToSession(ctx) };
  });
}
