import { unsafePrismaAdmin, withoutRls } from '@/lib/db';
import { InvalidInputError } from '@/lib/auth';
import { log } from '@/lib/logger';

// -----------------------------------------------------------------------------
// Multi-org switcher — Phase 3 rewrite.
//
// The active org used to live in a `bp_active_org` cookie that a request-time
// shim (resolveActiveOrg) preferred over the JWT. That combined badly with
// the Phase 3 auth core: the JWT carries `membershipId` + `platformRoleId`
// as authoritative claims, and a cookie couldn't reshape those without a DB
// round-trip on every request.
//
// New model: switching orgs invalidates the current JWT via `sessionVersion`
// bump, then the frontend triggers a fresh signIn('credentials', { orgId })
// to mint a new JWT with the desired membership selected. The credentials
// authorize() in auth.ts accepts the optional orgId and picks that
// membership; absent orgId, it picks the first (unchanged behaviour).
//
// Trade-off: switching org now costs a full re-sign-in (one extra HTTP round
// trip). In return: no drift, no request-time DB lookup, no cookie to
// invalidate on membership revoke, and the AuthContext cache in
// lib/rbac/context.ts stays keyed on a stable JWT payload.
// -----------------------------------------------------------------------------

export type MembershipSummary = {
  organizationId: string;
  organizationName: string;
  roleKey: string | null;
  legacyRole: 'owner' | 'practitioner' | 'receptionist';
};

/**
 * Every active membership the user holds, oldest-first. Feeds the org
 * picker UI. Uses withoutRls because a user's memberships span multiple orgs
 * by definition and no single org context applies.
 */
export async function listUserMemberships(userId: string): Promise<MembershipSummary[]> {
  return withoutRls(async (tx) => {
    const rows = await tx.membership.findMany({
      where: { userId, status: 'active' },
      include: {
        organization: { select: { name: true } },
        roleRef:      { select: { key: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      organizationId:   r.organizationId,
      organizationName: r.organization.name,
      roleKey:          r.roleRef?.key ?? null,
      legacyRole:       r.role,
    }));
  });
}

/**
 * Verifies the target membership belongs to the caller, then invalidates
 * their current session so the next request forces a re-sign-in. Callers
 * should follow this with a client-side `signIn('credentials', { orgId })`
 * carrying the same orgId — see app/api/session/switch/route.ts.
 *
 * Throws InvalidInputError on a bogus orgId (never leaks whether the org
 * exists at all).
 */
export async function switchActiveOrg(userId: string, orgId: string): Promise<void> {
  const membership = await withoutRls((tx) =>
    tx.membership.findFirst({
      where: { organizationId: orgId, userId, status: 'active' },
      select: { id: true },
    }),
  );
  if (!membership) throw new InvalidInputError('you are not a member of that organization');

  // Bump sessionVersion so any live JWT (including the one that made this
  // request) is rejected on the next call. The frontend then signs in
  // again with orgId in the credentials payload; authorize() picks that
  // membership and mints a new JWT.
  await unsafePrismaAdmin.appUser.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
  });
  log.info('org.switch', { userId, orgId });
}
