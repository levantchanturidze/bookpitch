// -----------------------------------------------------------------------------
// P17-001 — the role → landing contract.
//
// `app/page.tsx` sends a signed-in user somewhere. Getting that wrong is not a
// crash: the destination's own `requirePermission` refuses and the user meets
// the "Access Locked" panel on the first screen after sign-in. It looks like a
// broken account rather than a routing bug, and nothing fails until a human
// with that role happens to log in.
//
// The previous version encoded the mapping as a switch with the reasoning in
// comments — "MARKETING holds client.read:contact + report.branch but no
// booking.read". That comment is true at this commit. It is true because
// somebody checked once, and nothing rechecks it. A role bundle is edited in
// prisma/rbac-seed.ts, the comment stays, and the landing silently becomes
// unreachable for that role.
//
// So the mapping lives here as data, and tests/role-landing.test.ts evaluates
// it against the permissions actually seeded in the database, through can().
// Two things are pinned:
//
//   • every role that can hold a session has a landing (or is explicitly
//     recorded as having none), so adding a role without deciding where it
//     goes fails CI rather than shipping;
//   • the landing each role gets is one that role's permissions actually
//     authorise, and LANDING_PERMISSION still matches the guard the
//     destination page really runs.
//
// Runtime cost is unchanged. The root page still reads only the JWT — no DB
// query per home visit, which is what commit 3eb48d2 was reverted for.
// -----------------------------------------------------------------------------

/** Every destination the root page is allowed to choose. */
export type LandingRoute = '/scheduler' | '/patients' | '/analytics' | '/platform';

/**
 * The permission the destination's own guard demands. Mirrored from the
 * `requirePermission` call in LANDING_GUARD_SOURCE — the test asserts the two
 * still agree, so this cannot drift into being a decorative comment.
 */
export const LANDING_PERMISSION: Readonly<Record<LandingRoute, string>> = {
  '/scheduler': 'booking.read',
  '/patients': 'client.read:contact',
  '/analytics': 'report.branch',
  '/platform': 'platform.analytics.read',
};

/** Where each landing's guard lives, so the contract can be checked against it. */
export const LANDING_GUARD_SOURCE: Readonly<Record<LandingRoute, string>> = {
  '/scheduler': 'app/(app)/scheduler/page.tsx',
  '/patients': 'app/(app)/patients/page.tsx',
  '/analytics': 'app/(app)/analytics/page.tsx',
  '/platform': 'app/platform/layout.tsx',
};

/**
 * Org-plane role → landing. Every org-plane role in prisma/rbac-seed.ts must
 * appear here or in ROLES_WITHOUT_LANDING; the test fails otherwise.
 *
 * The rule is "the most useful surface this role can actually reach", not "the
 * surface most roles get". Roles are listed individually rather than behind a
 * `default:` because a default is what lets a new role inherit a destination
 * nobody checked.
 */
export const ORG_ROLE_LANDING: Readonly<Record<string, LandingRoute>> = {
  // booking.read at some scope — the calendar is the job.
  ORG_OWNER: '/scheduler',
  ORG_ADMIN: '/scheduler',
  BRANCH_MANAGER: '/scheduler',
  SENIOR_PROVIDER: '/scheduler',
  FRONT_DESK: '/scheduler',
  PROVIDER: '/scheduler',

  // No booking.read. Holds report.branch + org.billing.read, but NOT
  // org.settings.update:org, which the /settings/* layout requires — so
  // /analytics is the top-level page whose permission they hold.
  ACCOUNTANT: '/analytics',

  // No booking.read. Holds client.read:contact and report.branch, so both
  // /patients and /analytics are authorised; /patients is the more useful
  // surface for segment work.
  //
  // NOTE for whoever merges the frozen Phase 16 branch: that branch revokes
  // client.read:contact from MARKETING (migration
  // 20260823000001_revoke_marketing_client_contact) and does not touch this
  // mapping. When it lands, tests/role-landing.test.ts will fail on exactly
  // this line, and the fix is to move MARKETING to '/analytics', which
  // report.branch still authorises. That failure is the point of this file.
  MARKETING: '/patients',
};

/**
 * Roles that deliberately have no staff-app landing.
 *
 * CLIENT is a consumer-plane marker with zero permission rows (spec §4.3 —
 * client access is resolved by ownership, not RBAC). No code path assigns it
 * as a membership role, and it must not silently fall through to /scheduler,
 * where it would hit Access Locked.
 */
export const ROLES_WITHOUT_LANDING: ReadonlySet<string> = new Set(['CLIENT']);

/**
 * Landing for any platform-plane role. All four platform roles hold
 * `platform.analytics.read` (SUPER_ADMIN by the wildcard bundle), which is
 * what app/platform/layout.tsx requires.
 *
 * This one matters more than it looks: that layout redirects a ForbiddenError
 * back to '/', and '/' sends platform users to '/platform'. A platform role
 * lacking platform.analytics.read is therefore an infinite redirect loop, not
 * a 403. The test asserts every platform role holds it.
 */
export const PLATFORM_LANDING: LandingRoute = '/platform';

/**
 * Resolve the landing for a session. Pure — takes only what the JWT already
 * carries.
 *
 * Returns null when the caller has no landing: an unknown or landing-less
 * role. The root page treats null as "send them back to sign-in" rather than
 * guessing a destination, because a guess is what produces Access Locked.
 */
export function landingForRole(
  roleKey: string | null | undefined,
  hasPlatformRole: boolean,
): LandingRoute | null {
  if (hasPlatformRole) return PLATFORM_LANDING;
  if (!roleKey) return null;
  if (ROLES_WITHOUT_LANDING.has(roleKey)) return null;
  return ORG_ROLE_LANDING[roleKey] ?? null;
}
