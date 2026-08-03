import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));

const { unsafePrismaAdmin, withOrg } = await import('@/lib/db');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { switchActiveOrg } = await import('@/lib/org-switch');
const { requireAuthContext, can } = await import('@/lib/rbac');

// -----------------------------------------------------------------------------
// Phase 6 (spec §4.2 + §9 rule 10): the org switcher leaves no residue.
// After the moonlighter swaps from Grand Medical → Split Practice, the
// previous org's data must not be reachable — neither via can(), nor via
// the AuthContext cache, nor via the query layer (RLS at DB level).
// -----------------------------------------------------------------------------

describe('org switcher — no residue after switch', () => {
  let moonId: string;
  let grandOrgId: string;
  let splitOrgId: string;
  let grandCustomerId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const moon = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'moonlight@bp.test' },
    });
    moonId = moon.id;
    grandOrgId = (await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Grand Medical & Aurora Spa Group' }, select: { id: true },
    })).id;
    splitOrgId = (await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' }, select: { id: true },
    })).id;
    // Pick a Grand Medical customer to try to reach post-switch.
    const c = await unsafePrismaAdmin.customer.findFirst({ where: { organizationId: grandOrgId } });
    if (!c) throw new Error('seed must include a Grand Medical customer');
    grandCustomerId = c.id;
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
  });

  it('after switch: AuthContext cache does not surface previous org', async () => {
    // Step 1: sign in as moonlighter with Grand Medical active.
    authMock.mockResolvedValue(await mockJwt(moonId, grandOrgId));
    const grandCtx = await requireAuthContext();
    expect(grandCtx.activeOrganizationId).toBe(grandOrgId);
    // PROVIDER has client.read:contact by default — confirms Grand
    // membership is live before the switch.
    expect(can(grandCtx, 'client.read:contact', { organizationId: grandOrgId })).toBe(true);

    // Step 2: switch. bumps sessionVersion; subsequent JWT is invalidated
    // once the frontend re-signs-in with orgId=Split Practice.
    await switchActiveOrg(moonId, splitOrgId);

    // Step 3: simulate the fresh sign-in — mint the new JWT with Split
    // active.
    authMock.mockResolvedValue(await mockJwt(moonId, splitOrgId));
    __clearAuthContextCache();
    const splitCtx = await requireAuthContext();
    expect(splitCtx.activeOrganizationId).toBe(splitOrgId);
    expect(splitCtx.activeOrganizationId).not.toBe(grandOrgId);

    // Step 4: try to reach Grand's data using Split's ctx. can() must
    // deny (cross-tenant — Split ctx never grants access to Grand).
    expect(can(splitCtx, 'client.read:contact', { organizationId: grandOrgId })).toBe(false);
    expect(can(splitCtx, 'booking.read', { organizationId: grandOrgId })).toBe(false);
  });

  it('RLS blocks a raw query for Grand data from a Split-scoped withOrg', async () => {
    // withOrg opens a tenant-scoped connection with SET LOCAL
    // app.current_org_id. Any query for Grand's customers from inside
    // a Split-scoped tx should return zero rows even asked by id.
    const rows = await withOrg(splitOrgId, (tx) =>
      tx.customer.findMany({ where: { id: grandCustomerId } }),
    );
    expect(rows.length).toBe(0);
  });
});
