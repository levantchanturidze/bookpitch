import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { landingForRole } from '@/lib/rbac/landing';

// F-10: role-aware root landing. Reads the JWT via `auth()` — no DB
// query per home visit — and dispatches by `platformRoleId` + `roleKey`
// (both baked into the JWT at sign-in).
//
// An earlier attempt (reverted in 3eb48d2) put `requireAuthContext()`
// here — that hit the DB per home visit and made F-11's pool ceiling
// worse. The JWT already has everything we need; no query.
//
// P17-001: the mapping moved to lib/rbac/landing.ts so it can be checked
// against the permissions actually seeded for each role. It used to be a
// switch whose `default:` sent every unrecognised role to /scheduler and
// relied on app/(app)/error.tsx to catch the ones that could not read a
// booking. That turns a routing bug into an "Access Locked" panel on the
// first screen after sign-in, which reads as a broken account. A role
// with no landing now goes back to /signin instead of to a page we
// already know it cannot open.
export default async function Root() {
  const session = await auth();
  if (!session?.user) redirect('/signin');

  const landing = landingForRole(session.user.roleKey, Boolean(session.user.platformRoleId));

  // No landing: either a broken JWT (no org id and no platform role), a
  // consumer-plane role that does not belong in the staff app, or a role
  // added without a landing contract. All three are re-auth, not a guess.
  if (!landing) redirect('/signin');
  if (landing !== '/platform' && !session.user.activeOrganizationId) redirect('/signin');

  redirect(landing);
}
