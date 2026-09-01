import { describe, it, expect, beforeAll } from 'vitest';
import { unsafePrismaAdmin } from '@/lib/db';
import { can } from '@/lib/rbac/can';
import { perm, type AuthContext, type PermissionKey } from '@/lib/rbac/types';
import {
  ORG_ROLE_LANDING,
  ROLES_WITHOUT_LANDING,
  PLATFORM_LANDING,
  LANDING_PERMISSION,
  LANDING_GUARD_SOURCE,
  landingForRole,
  type LandingRoute,
} from '@/lib/rbac/landing';
import { scanEnforcement } from '@/scripts/check-orphan-perms';

// -----------------------------------------------------------------------------
// P17-001 — every role lands somewhere it is actually allowed to be.
//
// The failure this exists to catch is quiet by construction. Send a role to a
// page whose guard refuses it and nothing crashes: requirePermission throws,
// app/(app)/error.tsx renders "Access Locked", and the user sees what looks
// like a broken account on the first screen after sign-in. No log line says
// "routing sent this role somewhere it cannot go".
//
// So this reads the permissions actually seeded in the database — not a
// hard-coded expectation of what they should be — builds the AuthContext each
// role would get, and asks can() the same question the destination page asks.
//
// Every positive assertion is paired with a negative one. "MARKETING can open
// /patients" proves nothing on its own if can() returns true for everything;
// "MARKETING cannot open /scheduler" is what shows the check is live.
// -----------------------------------------------------------------------------

const ORG_ID = '00000000-0000-0000-0000-0000000000aa';

type SeededRole = { key: string; plane: string; permissions: string[] };

let roles: SeededRole[] = [];

/**
 * The AuthContext a member of `role` gets in a healthy, active organisation:
 * their seeded permission bundle, no branch restriction, default toggles (all
 * off — the most restrictive reading, which is how orgs are created).
 */
function ctxForRole(role: SeededRole): AuthContext {
  const isPlatform = role.plane === 'platform';
  return {
    userId: '00000000-0000-0000-0000-0000000000b1',
    email: `${role.key.toLowerCase()}@bp.test`,
    membershipId: isPlatform ? null : 'm1',
    activeOrganizationId: isPlatform ? null : ORG_ID,
    roleKey: isPlatform ? null : role.key,
    roleRank: 0,
    permissions: new Set(
      isPlatform ? [] : role.permissions.map(perm),
    ) as ReadonlySet<PermissionKey>,
    platformPermissions: new Set(
      isPlatform ? role.permissions.map(perm) : [],
    ) as ReadonlySet<PermissionKey>,
    branchIds: new Set() as ReadonlySet<string>,
    impersonation: null,
    isImpersonating: false,
    breakGlass: null,
    isBreakGlass: false,
    sessionVersion: 1,
    authSessionId: 's1',
    organizationStatus: isPlatform ? null : 'active',
    orgToggles: {
      providerFinancialReports: false,
      providerClinicalNotesOthers: false,
      frontdeskClientFullHistory: false,
      frontdeskDiscountCeiling: 0,
    },
  };
}

/** Ask the landing's own question: can this role open that page? */
function authorisedFor(role: SeededRole, route: LandingRoute): boolean {
  const key = LANDING_PERMISSION[route];
  // /platform's guard passes no resource; the org-plane pages pass the org id.
  const resource = route === '/platform' ? undefined : { organizationId: ORG_ID };
  return can(ctxForRole(role), key, resource);
}

beforeAll(async () => {
  const rows = await unsafePrismaAdmin.role.findMany({
    where: { organizationId: null, isSystem: true },
    select: { key: true, plane: true, permissions: { select: { permissionKey: true } } },
  });
  roles = rows.map((r) => ({
    key: r.key,
    plane: r.plane,
    permissions: r.permissions.map((p) => p.permissionKey),
  }));
  // Guard against an empty/unseeded database silently making every
  // "for each role" assertion vacuous.
  expect(roles.length).toBeGreaterThanOrEqual(13);
});

describe('every seeded role has a landing decision', () => {
  it('no org-plane role is missing from the contract', () => {
    const orgRoles = roles.filter((r) => r.plane === 'organization').map((r) => r.key);
    const undecided = orgRoles.filter(
      (k) => !(k in ORG_ROLE_LANDING) && !ROLES_WITHOUT_LANDING.has(k),
    );
    expect(undecided).toEqual([]);
    expect(orgRoles.length).toBeGreaterThan(0);
  });

  it('no consumer-plane role is silently routed into the staff app', () => {
    const consumerRoles = roles.filter((r) => r.plane === 'consumer').map((r) => r.key);
    for (const key of consumerRoles) {
      expect(ROLES_WITHOUT_LANDING.has(key)).toBe(true);
      expect(landingForRole(key, false)).toBeNull();
    }
  });

  it('the contract names no role that does not exist', () => {
    const seededKeys = new Set(roles.map((r) => r.key));
    for (const key of Object.keys(ORG_ROLE_LANDING)) expect(seededKeys.has(key)).toBe(true);
    for (const key of ROLES_WITHOUT_LANDING) expect(seededKeys.has(key)).toBe(true);
  });

  it('an unrecognised role gets no landing rather than a guess', () => {
    expect(landingForRole('ROLE_INVENTED_TOMORROW', false)).toBeNull();
    expect(landingForRole(null, false)).toBeNull();
    // …but a platform role still resolves, since it does not depend on roleKey.
    expect(landingForRole(null, true)).toBe(PLATFORM_LANDING);
  });
});

describe('each role can actually open the page it lands on', () => {
  it.each(Object.entries(ORG_ROLE_LANDING))(
    '%s lands on %s and its seeded permissions authorise it',
    (roleKey, route) => {
      const role = roles.find((r) => r.key === roleKey);
      expect(role, `${roleKey} is not seeded`).toBeDefined();
      expect(landingForRole(roleKey, false)).toBe(route);
      expect(
        authorisedFor(role!, route as LandingRoute),
        `${roleKey} lands on ${route} but lacks ${LANDING_PERMISSION[route as LandingRoute]}`,
      ).toBe(true);
    },
  );

  it('every platform role can open /platform — otherwise / ⇄ /platform loops', () => {
    // app/platform/layout.tsx redirects ForbiddenError back to '/', and '/'
    // sends any platform role to '/platform'. A platform role without
    // platform.analytics.read is an infinite redirect, not a 403.
    const platformRoles = roles.filter((r) => r.plane === 'platform');
    expect(platformRoles.length).toBeGreaterThan(0);
    for (const role of platformRoles) {
      expect(landingForRole(null, true)).toBe('/platform');
      expect(authorisedFor(role, '/platform'), `${role.key} would loop`).toBe(true);
    }
  });
});

describe('COMPLEMENT — the authorisation check is not vacuous', () => {
  it('roles without booking.read are refused /scheduler', () => {
    for (const key of ['ACCOUNTANT', 'MARKETING']) {
      const role = roles.find((r) => r.key === key)!;
      expect(authorisedFor(role, '/scheduler'), `${key} should not reach /scheduler`).toBe(false);
      // …and that is exactly why they are not routed there.
      expect(ORG_ROLE_LANDING[key]).not.toBe('/scheduler');
    }
  });

  it('roles without report.branch are refused /analytics', () => {
    for (const key of ['FRONT_DESK', 'PROVIDER']) {
      const role = roles.find((r) => r.key === key)!;
      expect(authorisedFor(role, '/analytics'), `${key} should not reach /analytics`).toBe(false);
    }
  });

  it('an org-plane role is refused /platform', () => {
    const owner = roles.find((r) => r.key === 'ORG_OWNER')!;
    expect(authorisedFor(owner, '/platform')).toBe(false);
  });

  it('the consumer role can open nothing', () => {
    const client = roles.find((r) => r.key === 'CLIENT')!;
    expect(client.permissions).toEqual([]);
    for (const route of Object.keys(LANDING_PERMISSION) as LandingRoute[]) {
      expect(authorisedFor(client, route), `CLIENT should not reach ${route}`).toBe(false);
    }
  });
});

describe('LANDING_PERMISSION still matches the guard each page runs', () => {
  // Without this, LANDING_PERMISSION is a second copy of a fact that lives in
  // the page — and a second copy is exactly what went stale last time.
  const references = scanEnforcement();

  it.each(Object.entries(LANDING_GUARD_SOURCE))(
    '%s guards on the permission the contract claims',
    (route, file) => {
      const expected = LANDING_PERMISSION[route as LandingRoute];
      const refs = references.get(expected) ?? [];
      const inFile = refs.filter((r) => r.file === file);
      expect(
        inFile.length,
        `${file} does not call requirePermission/can with '${expected}'`,
      ).toBeGreaterThan(0);
    },
  );
});
