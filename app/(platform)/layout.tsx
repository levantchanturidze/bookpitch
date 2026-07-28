import { redirect } from 'next/navigation';
import { UnauthenticatedError, ForbiddenError } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import PlatformShell from '@/components/platform/PlatformShell';

/**
 * Layout for every platform-plane route (`/platform/*`). Middleware
 * ensures a session exists; this layer requires the caller to hold a
 * platform-plane role via `platform.analytics.read` — the weakest
 * platform perm, granted to SUPER_ADMIN, PLATFORM_ADMIN, SUPPORT_AGENT,
 * and BILLING_MANAGER. Org-plane-only users get 403.
 *
 * Individual pages tighten this further (e.g. break-glass activation is
 * SUPER_ADMIN only, org.suspend requires `platform.org.suspend`).
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  let ctx;
  try {
    ctx = await requireAuthContext();
    requirePermission(ctx, 'platform.analytics.read', undefined, 'platform');
  } catch (err) {
    if (err instanceof UnauthenticatedError) redirect('/signin');
    if (err instanceof ForbiddenError) redirect('/');
    throw err;
  }

  return (
    <PlatformShell
      email={ctx.email}
      breakGlassActive={ctx.isBreakGlass}
      breakGlassExpiresAt={ctx.breakGlass?.expiresAt.toISOString() ?? null}
      impersonationActive={ctx.isImpersonating}
    >
      {children}
    </PlatformShell>
  );
}
