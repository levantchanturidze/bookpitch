import { redirect } from 'next/navigation';
import { auth } from '@/auth';

// F-10: role-aware root landing. Reads the JWT via `auth()` — no DB
// query per home visit — and dispatches by `platformRoleId` + `roleKey`
// (both baked into the JWT at sign-in). Anyone landing on a page they
// can't fully view still gets the app/(app)/error.tsx "Access Locked"
// panel via requirePermission, but the default landing now matches
// the role's home.
//
// An earlier attempt (reverted in 3eb48d2) put `requireAuthContext()`
// here — that hit the DB per home visit and made F-11's pool ceiling
// worse. The JWT already has everything we need; no query.
export default async function Root() {
  const session = await auth();
  if (!session?.user) redirect('/signin');

  // Platform users don't have an org context; send them to /platform.
  if (session.user.platformRoleId) redirect('/platform');

  // Broken JWT (no org id, no platform role) — force re-auth.
  if (!session.user.activeOrganizationId) redirect('/signin');

  // Route by org-plane role. Roles that hold `booking.read` at some
  // scope get /scheduler; role-limited holders land on pages they can
  // actually reach. Anything else falls through to /scheduler and, if
  // the caller lacks the perm, hits app/(app)/error.tsx's friendly
  // Access Locked panel — not a 500.
  switch (session.user.roleKey) {
    case 'ACCOUNTANT':
      // ACCOUNTANT holds report.branch + org.billing.read but NOT
      // org.settings.update:org, which the /settings/* layout requires.
      // Send them to /analytics instead — that's a top-level page whose
      // permission (report.branch) they hold.
      redirect('/analytics');
    case 'MARKETING':
      // MARKETING holds client.read:contact + report.branch but no
      // booking.read. /patients is their most useful surface.
      redirect('/patients');
    default:
      // ORG_OWNER, ORG_ADMIN, BRANCH_MANAGER, SENIOR_PROVIDER,
      // FRONT_DESK, PROVIDER — all have booking.read at some scope.
      redirect('/scheduler');
  }
}
