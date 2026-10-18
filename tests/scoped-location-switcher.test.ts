import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// The active-location cookie, under the test's control: what the browser sends,
// and what the server tries to set.
const { jar } = vi.hoisted(() => ({
  jar: { value: undefined as string | undefined, sets: [] as string[] },
}));
vi.mock('next/headers', async () => {
  const actual = await vi.importActual<typeof import('next/headers')>('next/headers');
  return {
    ...actual,
    cookies: async () => ({
      get: (name: string) =>
        name === 'bookpitch.activeLocationId' && jar.value ? { name, value: jar.value } : undefined,
      set: (_name: string, value: string) => {
        jar.sets.push(value);
      },
    }),
  };
});

const { withoutRls } = await import('@/lib/db');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { buildAuthContext, navigableLocationIds } = await import('@/lib/rbac');
const { loadLocationsForCaller } = await import('@/lib/active-location');
const { setActiveLocationAction } = await import('@/components/shell/actions');
const { setMemberBranches } = await import('@/lib/admin/scoped-access');
const appLayout = await import('@/app/(app)/layout');
const schedulerPage = await import('@/app/(app)/scheduler/page');
const remindersPage = await import('@/app/(app)/reminders/page');
const billingPage = await import('@/app/(app)/billing/page');
const analyticsPage = await import('@/app/(app)/analytics/page');
const patientsPage = await import('@/app/(app)/patients/page');
const appointmentsRoute = await import('@/app/api/appointments/route');

import type { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// Backlog E — the location switcher shows the locations a member can actually
// reach, and nothing else decides the active one.
//
// loadLocationsForOrg() returned every location of the organisation to every
// member. A receptionist scoped to branch A was offered branch B by name and,
// on switching, an empty view; a member with NO branches saw every location and
// nothing in any of them; and a stale or hand-set cookie could make an
// out-of-scope location the active one (scoped-RBAC audit §7).
// -----------------------------------------------------------------------------

type Who =
  'owner' | 'fdA' | 'fdAB' | 'fdNone' | 'provider' | 'accountant' | 'managerB' | 'managerNone';
type Fx = {
  orgId: string;
  users: Record<Who, string>;
  memberships: Record<Who, string>;
  locA: string;
  locB: string;
  locC: string;
  branchA: string;
  branchB: string;
};
let fx: Fx;
const ts = Date.now();
const createdUsers: string[] = [];

async function as(who: Who) {
  __clearAuthContextCache();
  authMock.mockResolvedValue(await mockJwt(fx.users[who], fx.orgId));
}
async function ctxOf(who: Who) {
  __clearAuthContextCache();
  return (await buildAuthContext(fx.users[who], fx.memberships[who]))!;
}
const sorted = (xs: string[]) => [...xs].sort();
function findProp<T>(el: unknown, key: string): T | undefined {
  if (!el || typeof el !== 'object') return undefined;
  const props = (el as { props?: Record<string, unknown> }).props;
  if (!props) return undefined;
  if (key in props) return props[key] as T;
  const children = Array.isArray(props.children) ? props.children : [props.children];
  for (const c of children) {
    const hit = findProp<T>(c, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

beforeAll(async () => {
  fx = await withoutRls(async (tx) => {
    const role = async (key: string) =>
      (
        await tx.role.findFirstOrThrow({
          where: { key, organizationId: null },
          select: { id: true },
        })
      ).id;
    const org = await tx.organization.create({ data: { name: `LS Org ${ts}` } });
    const loc = (name: string, type: 'clinic' | 'salon') =>
      tx.location.create({ data: { organizationId: org.id, type, name }, select: { id: true } });
    const locA = (await loc('LS Clinic A', 'clinic')).id;
    const locB = (await loc('LS Clinic B', 'clinic')).id;
    const locC = (await loc('LS Salon C', 'salon')).id;
    const branchOf = async (locationId: string) =>
      (await tx.branch.findFirstOrThrow({ where: { legacyLocationId: locationId } })).id;
    const branchA = await branchOf(locA);
    const branchB = await branchOf(locB);

    const users = {} as Record<Who, string>;
    const memberships = {} as Record<Who, string>;
    const add = async (
      who: Who,
      legacy: 'owner' | 'practitioner' | 'receptionist',
      roleKey: string,
      branches: string[] = [],
    ) => {
      const u = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `ls-${who}-${ts}@bookpitch.dev`,
          email: `ls-${who}-${ts}@bookpitch.dev`,
        },
        select: { id: true },
      });
      createdUsers.push(u.id);
      const m = await tx.membership.create({
        data: { organizationId: org.id, userId: u.id, role: legacy, roleId: await role(roleKey) },
        select: { id: true },
      });
      for (const b of branches) {
        await tx.membershipBranch.create({ data: { membershipId: m.id, branchId: b } });
      }
      users[who] = u.id;
      memberships[who] = m.id;
    };
    await add('owner', 'owner', 'ORG_OWNER');
    await add('fdA', 'receptionist', 'FRONT_DESK', [branchA]);
    await add('fdAB', 'receptionist', 'FRONT_DESK', [branchA, branchB]);
    await add('fdNone', 'receptionist', 'FRONT_DESK');
    await add('provider', 'practitioner', 'PROVIDER');
    await add('accountant', 'receptionist', 'ACCOUNTANT');
    await add('managerB', 'receptionist', 'BRANCH_MANAGER', [branchB]);
    await add('managerNone', 'receptionist', 'BRANCH_MANAGER');
    await tx.organization.update({ where: { id: org.id }, data: { ownerUserId: users.owner } });
    return { orgId: org.id, users, memberships, locA, locB, locC, branchA, branchB };
  });
});

afterAll(async () => {
  if (!fx) return;
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs([fx.orgId]);
  await withoutRls(async (tx) => {
    await tx.membershipBranch.deleteMany({
      where: { membershipId: { in: Object.values(fx.memberships) } },
    });
    await tx.membership.deleteMany({ where: { organizationId: fx.orgId } });
    await tx.location.deleteMany({ where: { organizationId: fx.orgId } });
    await tx.organization.update({ where: { id: fx.orgId }, data: { ownerUserId: null } });
  });
  await withoutRls(async (tx) => {
    await tx.appUser.deleteMany({ where: { id: { in: createdUsers } } });
    await tx.organization.deleteMany({ where: { id: fx.orgId } });
  });
});

beforeEach(() => {
  authMock.mockReset();
  __clearAuthContextCache();
  jar.value = undefined;
  jar.sets.length = 0;
});

// -----------------------------------------------------------------------------
describe('which locations a member may navigate to', () => {
  it.each([
    'owner',
    'provider', // :own — their bookings can be at any location
    'accountant', // no booking grant: organisation-wide reports
  ] as const)('%s reaches every location', async (who) => {
    expect(await navigableLocationIds(await ctxOf(who))).toBeNull();
  });

  it('a branch-scoped member reaches exactly the LOCATIONS of their branches', async () => {
    expect(await navigableLocationIds(await ctxOf('fdA'))).toEqual([fx.locA]);
    expect(sorted((await navigableLocationIds(await ctxOf('fdAB')))!)).toEqual(
      sorted([fx.locA, fx.locB]),
    );
    expect(await navigableLocationIds(await ctxOf('managerB'))).toEqual([fx.locB]);
  });

  it('branch ids are mapped to their locations, never compared with them', async () => {
    const ids = (await navigableLocationIds(await ctxOf('fdAB')))!;
    expect(ids).not.toContain(fx.branchA);
    expect(ids).not.toContain(fx.branchB);
    // The fixture is only meaningful if the two id spaces really differ.
    expect(fx.branchA).not.toBe(fx.locA);
  });

  it('an EMPTY branch set reaches nothing — it is not organisation-wide', async () => {
    expect(await navigableLocationIds(await ctxOf('fdNone'))).toEqual([]);
    expect(await navigableLocationIds(await ctxOf('managerNone'))).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('the switcher and the active location', () => {
  it('an organisation-wide member is offered every location, first clinic by default', async () => {
    const { locations, active } = await loadLocationsForCaller(await ctxOf('owner'));
    expect(sorted(locations.map((l) => l.id))).toEqual(sorted([fx.locA, fx.locB, fx.locC]));
    expect(active?.type).toBe('clinic');
  });

  it('a one-branch member is offered that location only, and a cookie naming another is ignored', async () => {
    jar.value = fx.locB; // stale, or hand-set
    const { locations, active } = await loadLocationsForCaller(await ctxOf('fdA'));
    expect(locations.map((l) => l.id)).toEqual([fx.locA]);
    expect(active?.id).toBe(fx.locA);
  });

  it('a two-branch member is offered both, and the cookie chooses between them', async () => {
    jar.value = fx.locB;
    const { locations, active } = await loadLocationsForCaller(await ctxOf('fdAB'));
    expect(sorted(locations.map((l) => l.id))).toEqual(sorted([fx.locA, fx.locB]));
    expect(locations.map((l) => l.id)).not.toContain(fx.locC);
    expect(active?.id).toBe(fx.locB);
  });

  it('a member with no branches is offered nothing and has no active location', async () => {
    const { locations, active } = await loadLocationsForCaller(await ctxOf('fdNone'));
    expect(locations).toEqual([]);
    expect(active).toBeNull();
  });

  it('narrowing a member’s branches takes effect on their next request — the old cookie loses', async () => {
    const owner = {
      userId: fx.users.owner,
      email: 'o@x.invalid',
      organizationId: fx.orgId,
      membershipId: fx.memberships.owner,
    };
    jar.value = fx.locB;
    expect((await loadLocationsForCaller(await ctxOf('fdAB'))).active?.id).toBe(fx.locB);
    await setMemberBranches(owner, fx.memberships.fdAB, [fx.branchA]);
    try {
      const after = await loadLocationsForCaller(await ctxOf('fdAB'));
      expect(after.locations.map((l) => l.id)).toEqual([fx.locA]);
      expect(after.active?.id).toBe(fx.locA);
    } finally {
      await setMemberBranches(owner, fx.memberships.fdAB, [fx.branchA, fx.branchB]);
    }
  });
});

// -----------------------------------------------------------------------------
describe('setActiveLocationAction — the server decides, not the form', () => {
  it('stores a location the member can reach', async () => {
    await as('fdA');
    await setActiveLocationAction(fx.locA);
    expect(jar.sets).toEqual([fx.locA]);
  });

  it('refuses a crafted id outside the member’s branches, and stores nothing', async () => {
    await as('fdA');
    await setActiveLocationAction(fx.locB);
    await setActiveLocationAction(fx.locC);
    expect(jar.sets).toEqual([]);
  });

  it('refuses everything for a member with no branches', async () => {
    await as('fdNone');
    await setActiveLocationAction(fx.locA);
    expect(jar.sets).toEqual([]);
  });

  it('an organisation-wide member may choose any location', async () => {
    await as('owner');
    await setActiveLocationAction(fx.locC);
    expect(jar.sets).toEqual([fx.locC]);
  });
});

// -----------------------------------------------------------------------------
describe('what the shell and the pages render', () => {
  async function layoutFor(who: Who) {
    await as(who);
    return (await appLayout.default({ children: null })) as ReactElement;
  }

  it("the shell lists only the member's locations", async () => {
    const el = await layoutFor('fdAB');
    const locs = findProp<Array<{ id: string; name: string }>>(el, 'locations') ?? [];
    expect(sorted(locs.map((l) => l.name))).toEqual(['LS Clinic A', 'LS Clinic B']);
  });

  it('a member with no branches gets an explicit state — no locations, no active one', async () => {
    const el = await layoutFor('fdNone');
    expect(findProp<unknown[]>(el, 'locations')).toEqual([]);
    expect(findProp<unknown>(el, 'activeLocation')).toBeNull();
  });

  it.each([
    ['scheduler', () => schedulerPage.default({ searchParams: Promise.resolve({}) })],
    ['reminders', () => remindersPage.default()],
    ['billing', () => billingPage.default()],
  ] as const)('/%s says "no location assigned" instead of an empty view', async (_name, render) => {
    await as('fdNone');
    const html = renderToStaticMarkup((await render()) as ReactElement);
    expect(html).toContain('No location assigned');
  });

  it('/analytics says so too, for a branch manager with no branches', async () => {
    await as('managerNone');
    const html = renderToStaticMarkup((await analyticsPage.default()) as ReactElement);
    expect(html).toContain('No location assigned');
  });

  it('/patients still renders — customers are organisation-level, the location only names them', async () => {
    await as('fdNone');
    const el = (await patientsPage.default()) as ReactElement;
    expect(findProp<string>(el, 'locationType')).toBe('clinic');
  });

  it('a stale cookie naming another branch cannot make /scheduler show it', async () => {
    jar.value = fx.locB;
    await as('fdA');
    const el = await schedulerPage.default({ searchParams: Promise.resolve({}) });
    expect(findProp<{ id: string }>(el, 'location')?.id).toBe(fx.locA);
  });
});

// -----------------------------------------------------------------------------
describe('the server stays authoritative whatever the switcher shows', () => {
  it('asking the appointments API for an out-of-branch location is refused', async () => {
    await as('fdA');
    const range = `from=${encodeURIComponent('2031-06-01T00:00:00.000Z')}&to=${encodeURIComponent('2031-06-30T00:00:00.000Z')}`;
    const res = await appointmentsRoute.GET(
      new Request(
        `http://x/api/appointments?${range}&locationId=${fx.locB}`,
      ) as unknown as NextRequest,
    );
    expect(res.status).toBe(400);
    // Its twin: the member's own location is served.
    await as('fdA');
    const ok = await appointmentsRoute.GET(
      new Request(
        `http://x/api/appointments?${range}&locationId=${fx.locA}`,
      ) as unknown as NextRequest,
    );
    expect(ok.status).toBe(200);
  });
});
