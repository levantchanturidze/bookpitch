import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { NAV_ITEMS } from '@/components/shell/nav-items';
import { UnauthenticatedError } from '@/lib/auth';

// P17-013. A page no longer throws ForbiddenError on a denial: it calls
// Next's `forbidden()`, which throws an error carrying this digest and makes
// the response a 403 rendering app/(app)/forbidden.tsx. Asserting the digest
// rather than an error class is what keeps this test measuring the refusal
// users actually receive — the ForbiddenError version passed while production
// was answering 500.
const FORBIDDEN_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;403';

// vi.mock() is hoisted above `const` declarations, so the mock ref must be
// created via vi.hoisted() to be visible when the factory runs.
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// Pages read locations from the DB; stub with a real uuid so /scheduler
// (which uses the id in further Prisma queries) doesn't blow up on cast.
const { locationMock } = vi.hoisted(() => ({ locationMock: vi.fn() }));
vi.mock('@/lib/active-location', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/active-location')>('@/lib/active-location');
  return { ...actual, loadLocationsForOrg: locationMock };
});

// Dynamic imports so the mocks are in place first.
const pages: Record<string, () => Promise<{ default: () => Promise<unknown> }>> = {
  scheduler: () => import('@/app/(app)/scheduler/page'),
  patients: () => import('@/app/(app)/patients/page'),
  reminders: () => import('@/app/(app)/reminders/page'),
  billing: () => import('@/app/(app)/billing/page'),
  analytics: () => import('@/app/(app)/analytics/page'),
};

// Phase 4 mapping: fixture users → expected can() outcome per nav id.
// Each fixture user resolves to a real membership so buildAuthContext
// returns a real ctx. If a role gains/loses a permission in a Phase 6
// admin edit, this test tells us which pages need attention.
type FixtureUser = { email: string; roleKey: string; canByNavId: Record<string, boolean> };

const USERS: FixtureUser[] = [
  {
    email: 'split-owner@bp.test',
    roleKey: 'ORG_OWNER',
    canByNavId: {
      scheduler: true,
      patients: true,
      reminders: true,
      billing: true,
      analytics: true,
    },
  },
  {
    email: 'moonlight@bp.test',
    roleKey: 'PROVIDER',
    // PROVIDER's grants are booking.*:own, client.read:contact, report.own.
    // Post-F-09 (2026-08-03), :own-scoped list-mode calls are GRANTED by
    // can() with the trust model that the query layer filters by
    // ctx.userId (scopedByOwn). So `scheduler` and `reminders` now render
    // for PROVIDER — showing only their own bookings — rather than 403.
    // billing / analytics still deny (payment.charge / report.branch not
    // in the :own scope pattern).
    canByNavId: {
      scheduler: true,
      patients: true,
      reminders: true,
      billing: false,
      analytics: false,
    },
  },
  {
    email: 'splitmgr@bp.test',
    roleKey: 'BRANCH_MANAGER',
    canByNavId: {
      // BRANCH_MANAGER: booking.read:branch YES, client.read:contact YES,
      // booking.update:branch YES (list-mode / no resource), payment.charge YES,
      // report.branch YES.
      scheduler: true,
      patients: true,
      reminders: true,
      billing: true,
      analytics: true,
    },
  },
];

async function jwtFor(email: string) {
  const { unsafePrismaAdmin } = await import('@/lib/db');
  const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({ where: { email } });
  const membership = await unsafePrismaAdmin.membership
    .findFirstOrThrow({
      where: { userId: user.id, organization: { name: 'Split Practice' } },
    })
    .catch(async () =>
      // Some users only have a Grand Medical membership; fall back.
      unsafePrismaAdmin.membership.findFirstOrThrow({ where: { userId: user.id } }),
    );
  return {
    user: {
      id: user.id,
      email: user.email,
      activeOrganizationId: membership.organizationId,
      membershipId: membership.id,
      platformRoleId: null,
      organizationId: membership.organizationId,
      role: membership.role,
    },
  };
}

describe('page-level guards match NAV_ITEMS.requiredPermission', () => {
  beforeAll(async () => {
    const { unsafePrismaAdmin } = await import('@/lib/db');
    const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
    await seedRbacFixtures();

    // The fixture users all resolve to Split Practice memberships (see
    // jwtFor). Use Split's own location so pages that dereference
    // `active.id` in a withOrg query actually find it — a location from a
    // different org would be filtered by RLS.
    const loc = await unsafePrismaAdmin.location.findFirstOrThrow({
      where: { organization: { name: 'Split Practice' } },
    });
    locationMock.mockImplementation(async () => ({
      locations: [{ id: loc.id, name: loc.name, type: loc.type }],
      active: { id: loc.id, name: loc.name, type: loc.type },
    }));
  });

  beforeEach(async () => {
    authMock.mockReset();
    const { __clearAuthContextCache } = await import('@/lib/rbac/context');
    __clearAuthContextCache();
  });

  // `forbidden()` refuses to work unless the build enabled
  // experimental.authInterrupts. `next start` sets this from next.config.ts;
  // vitest is not a Next build, so the suite supplies it and puts it back.
  const previousAuthInterrupts = process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS;
  beforeAll(() => {
    process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = '1';
  });
  afterAll(() => {
    if (previousAuthInterrupts === undefined)
      delete process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS;
    else process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = previousAuthInterrupts;
  });

  for (const user of USERS) {
    describe(`user ${user.email} (${user.roleKey})`, () => {
      for (const item of NAV_ITEMS) {
        const load = pages[item.id];
        if (!load) continue;
        const shouldAllow = user.canByNavId[item.id];

        it(`/${item.id} → ${shouldAllow ? 'renders' : '403 interrupt'}`, async () => {
          authMock.mockResolvedValue(await jwtFor(user.email));
          const { default: Page } = await load();
          if (shouldAllow) {
            const result = await Page();
            expect(result).toBeDefined();
          } else {
            await expect(Page()).rejects.toMatchObject({ digest: FORBIDDEN_DIGEST });
          }
        });
      }
    });
  }

  it('anonymous → UnauthenticatedError on /scheduler', async () => {
    authMock.mockResolvedValue(null);
    const { default: Page } = await pages.scheduler();
    await expect(Page()).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
