import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NAV_ITEMS } from '@/components/shell/nav-items';
import { ForbiddenError, UnauthenticatedError } from '@/lib/auth';

// vi.mock() is hoisted above `const` declarations, so the mock ref must be
// created via vi.hoisted() to be visible when the factory runs.
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// Pages read locations from the DB; stub with a fixed shape so we don't need
// a real org id for the "allowed" case.
vi.mock('@/lib/active-location', async () => {
  const actual = await vi.importActual<typeof import('@/lib/active-location')>(
    '@/lib/active-location',
  );
  return {
    ...actual,
    loadLocationsForOrg: vi.fn(async () => ({
      locations: [{ id: 'loc-1', name: 'Grand Medical Suite', type: 'clinic' as const }],
      active: { id: 'loc-1', name: 'Grand Medical Suite', type: 'clinic' as const },
    })),
  };
});

// Dynamic imports so the mocks are in place first.
const pages: Record<string, () => Promise<{ default: () => Promise<unknown> }>> = {
  scheduler: () => import('@/app/(app)/scheduler/page'),
  patients: () => import('@/app/(app)/patients/page'),
  reminders: () => import('@/app/(app)/reminders/page'),
  billing: () => import('@/app/(app)/billing/page'),
  analytics: () => import('@/app/(app)/analytics/page'),
};

const ALL_ROLES = ['owner', 'practitioner', 'receptionist'] as const;

// Some pages (like /patients since P1.4) touch the DB and write audit_log —
// they need a REAL orgId + userId that satisfies the FKs. Pull them once
// from the seeded state.
let realOrgId = '';
let realUserId = '';

function makeSession(role: (typeof ALL_ROLES)[number]) {
  return {
    user: {
      id: realUserId,
      email: `${role}@example.dev`,
      organizationId: realOrgId,
      role,
    },
  };
}

describe('module route access matches NAV_ITEMS.allowedRoles', () => {
  beforeAll(async () => {
    const { withoutRls } = await import('@/lib/db');
    const [org, owner] = await Promise.all([
      withoutRls((tx) => tx.organization.findFirst({ orderBy: { createdAt: 'asc' } })),
      withoutRls((tx) =>
        tx.appUser.findUnique({ where: { email: 'owner@bookpitch.dev' }, select: { id: true } }),
      ),
    ]);
    realOrgId = org!.id;
    realUserId = owner!.id;
  });

  beforeEach(() => authMock.mockReset());

  for (const item of NAV_ITEMS) {
    const load = pages[item.id];
    if (!load) continue;

    describe(`/${item.id}`, () => {
      for (const role of ALL_ROLES) {
        const shouldAllow = item.allowedRoles.includes(role);

        it(`${role} → ${shouldAllow ? 'renders' : 'ForbiddenError'}`, async () => {
          authMock.mockResolvedValue(makeSession(role));
          const { default: Page } = await load();

          if (shouldAllow) {
            const result = await Page();
            // Page function returns a React element (object). Not throwing =
            // guard passed and downstream work ran.
            expect(result).toBeDefined();
          } else {
            await expect(Page()).rejects.toBeInstanceOf(ForbiddenError);
          }
        });
      }

      it('anonymous → UnauthenticatedError', async () => {
        authMock.mockResolvedValue(null);
        const { default: Page } = await load();
        await expect(Page()).rejects.toBeInstanceOf(UnauthenticatedError);
      });
    });
  }
});
