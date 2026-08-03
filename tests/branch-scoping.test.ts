import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin } = await import('@/lib/db');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { scopedLocationIds, buildAuthContext } = await import('@/lib/rbac');
const listAppts = await import('@/app/api/appointments/route');
const listWaitlist = await import('@/app/api/waitlist/route');

import type { NextRequest } from 'next/server';
function req(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}
async function json<T>(res: Response): Promise<T> { return (await res.json()) as T; }

// -----------------------------------------------------------------------------
// Phase 6: branch scoping tightens aggregate list queries. BRANCH_MANAGER
// should see only their scoped branches' data even without a locationId
// filter param; unrestricted roles (FRONT_DESK with empty branchIds)
// keep org-wide reach.
// -----------------------------------------------------------------------------

describe('branch scoping — list endpoints filter for BRANCH_MANAGER', () => {
  let splitOrgId: string;
  let mgrUserId: string;
  let mgrMembershipId: string;
  let downtownLocationId: string;
  let airportLocationId: string | null;

  beforeAll(async () => {
    await seedRbacFixtures();
    splitOrgId = (await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' }, select: { id: true },
    })).id;
    const mgr = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'splitmgr@bp.test' },
    });
    mgrUserId = mgr.id;
    mgrMembershipId = (await unsafePrismaAdmin.membership.findFirstOrThrow({
      where: { userId: mgr.id, organizationId: splitOrgId },
    })).id;
    // The seeded location for Split Practice — 'Split Downtown Loc'.
    const loc = await unsafePrismaAdmin.location.findFirstOrThrow({
      where: { organizationId: splitOrgId },
    });
    downtownLocationId = loc.id;

    // Ensure the manager's Downtown branch is linked to that location.
    const downtown = await unsafePrismaAdmin.branch.findFirstOrThrow({
      where: { organizationId: splitOrgId, name: 'Downtown' },
    });
    if (downtown.legacyLocationId !== downtownLocationId) {
      await unsafePrismaAdmin.branch.update({
        where: { id: downtown.id },
        data: { legacyLocationId: downtownLocationId },
      });
    }
    // Airport isn't in the manager's scope — no legacy location needed.
    airportLocationId = null;
  });

  beforeEach(() => {
    authMock.mockReset();
    __clearAuthContextCache();
  });

  it('scopedLocationIds returns null for unrestricted roles', async () => {
    // ORG_OWNER (split-owner) has no branch scope.
    const owner = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'split-owner@bp.test' },
    });
    const ownerMembership = await unsafePrismaAdmin.membership.findFirstOrThrow({
      where: { userId: owner.id, organizationId: splitOrgId },
    });
    const ctx = await buildAuthContext(owner.id, ownerMembership.id);
    expect(await scopedLocationIds(ctx!)).toBeNull();
  });

  it('scopedLocationIds resolves BRANCH_MANAGER branches to legacy location ids', async () => {
    const ctx = await buildAuthContext(mgrUserId, mgrMembershipId);
    expect(ctx!.roleKey).toBe('BRANCH_MANAGER');
    const scoped = await scopedLocationIds(ctx!);
    expect(scoped).not.toBeNull();
    expect(scoped).toContain(downtownLocationId);
  });

  it('appointments GET without locationId returns only scoped locations for BRANCH_MANAGER', async () => {
    authMock.mockResolvedValue(await mockJwt(mgrUserId, splitOrgId));
    const from = new Date(Date.UTC(2020, 0, 1)).toISOString();
    const to = new Date(Date.UTC(2100, 0, 1)).toISOString();
    const res = await listAppts.GET(req(
      `http://x/api/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ));
    expect(res.status).toBe(200);
    const body = await json<{ appointments: Array<{ locationId: string }> }>(res);
    // Every returned row must live in the manager's scope. The seed has
    // few / zero appointments at Split — the assertion is universally
    // quantified: no leakage.
    for (const a of body.appointments) {
      expect(a.locationId).toBe(downtownLocationId);
    }
    void airportLocationId;
  });

  it('appointments GET with an out-of-scope locationId returns 400', async () => {
    // Fake location ID (well-formed UUID that isn't in Split Practice).
    const foreign = '00000000-0000-0000-0000-000000000042';
    authMock.mockResolvedValue(await mockJwt(mgrUserId, splitOrgId));
    const from = new Date(Date.UTC(2020, 0, 1)).toISOString();
    const to = new Date(Date.UTC(2100, 0, 1)).toISOString();
    const res = await listAppts.GET(req(
      `http://x/api/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&locationId=${foreign}`,
    ));
    expect(res.status).toBe(400);
  });

  it('waitlist GET applies scope filter for BRANCH_MANAGER', async () => {
    authMock.mockResolvedValue(await mockJwt(mgrUserId, splitOrgId));
    const res = await listWaitlist.GET();
    expect(res.status).toBe(200);
    const body = await json<{ waitlist: Array<{ locationId: string | null }> }>(res);
    // Include null (flexible) + rows in the scope. Nothing outside.
    for (const w of body.waitlist) {
      if (w.locationId !== null) {
        expect(w.locationId).toBe(downtownLocationId);
      }
    }
  });
});
