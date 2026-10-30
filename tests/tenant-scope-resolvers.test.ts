import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// RLS is what normally hides another organisation's rows from withOrg. Here it
// is taken away: withOrg runs on the RLS-bypassing client. That is the failure
// the explicit filters exist for (CLAUDE.md invariant 1: a query without
// organization_id is a bug "regardless of what the surrounding code appears to
// guarantee"), and the only condition under which they are observable. Same
// technique as tests/send-now-org-scope.test.ts (#125).
vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  return {
    ...actual,
    withOrg: (<T>(_orgId: string, fn: Parameters<typeof actual.withoutRls<T>>[0]) =>
      actual.withoutRls(fn)) as typeof actual.withOrg,
  };
});

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const {
  resolveAppointmentResource,
  resolveBookingOwner,
  resolveStaffResource,
  resolveWaitlistResource,
  scopedLocationIds,
} = await import('@/lib/rbac/scope');
const { perm } = await import('@/lib/rbac/types');
const routeAppointment = await import('@/app/api/appointments/[id]/route');
const routeWaitlist = await import('@/app/api/waitlist/[id]/route');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');

import type { NextRequest } from 'next/server';
import type { AuthContext } from '@/lib/rbac/types';

// -----------------------------------------------------------------------------
// DEF-08: the resolvers in lib/rbac/scope.ts are where a concrete mutation is
// authorised. Each loads one row by id and returns a Resource that ASSERTS
// `organizationId: <the caller's organisation>`; can() then authorises against
// that assertion. They loaded the row by id alone, so the assertion was true
// only because RLS made it so. Without RLS, organisation A's owner resolved
// organisation B's appointment as A's, passed can(), and the route's own write
// (also RLS-only) changed B's row.
// -----------------------------------------------------------------------------

const stamp = Date.now();
const fx = {
  orgA: '',
  orgB: '',
  ownerA: '',
  ownerB: '',
  locB: '',
  branchB: '',
  staffB: '',
  apptB: '',
  waitlistB: '',
  waitlistB2: '',
};

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

async function signInAs(userId: string, orgId: string) {
  __clearAuthContextCache();
  authMock.mockResolvedValue(await mockJwt(userId, orgId));
}

beforeAll(async () => {
  const seeded = await withoutRls(async (tx) => {
    const ownerRole = await tx.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
      select: { id: true },
    });
    const out: Record<string, string> = {};
    for (const tag of ['A', 'B']) {
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `tenant-scope-${tag}-${stamp}@bp.test`,
          email: `tenant-scope-${tag}-${stamp}@bp.test`,
        },
        select: { id: true },
      });
      // Active, with its owner: can() refuses everything in an archived org,
      // and a live organisation must keep an owner (invariant 5).
      const org = await tx.organization.create({
        data: { name: `tenant-scope-${tag}-${stamp}`, status: 'active', ownerUserId: user.id },
        select: { id: true },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: user.id, role: 'owner', roleId: ownerRole.id },
      });
      out[`org${tag}`] = org.id;
      out[`owner${tag}`] = user.id;
    }
    // Organisation B's data. The location's branch is created by the
    // locations_rbac_sync_insert trigger.
    const loc = await tx.location.create({
      data: { organizationId: out.orgB, name: 'B', type: 'clinic', timezone: 'UTC' },
      select: { id: true },
    });
    const branch = await tx.branch.findFirstOrThrow({
      where: { legacyLocationId: loc.id },
      select: { id: true },
    });
    const staff = await tx.staff.create({
      data: {
        organizationId: out.orgB,
        locationId: loc.id,
        userId: out.ownerB,
        name: 'B Dr',
        roleTitle: 'GP',
      },
      select: { id: true },
    });
    const customer = await tx.customer.create({
      data: { organizationId: out.orgB, name: 'B Customer', phone: '+995500000808' },
      select: { id: true },
    });
    const startsAt = new Date(Date.now() + 5 * 24 * 3_600_000);
    const appt = await tx.appointment.create({
      data: {
        organizationId: out.orgB,
        locationId: loc.id,
        customerId: customer.id,
        staffId: staff.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        serviceName: 'Consult',
        price: 10,
        status: 'confirmed',
      },
      select: { id: true },
    });
    const entry = () =>
      tx.waitlist.create({
        data: {
          organizationId: out.orgB,
          customerId: customer.id,
          staffId: staff.id,
          preferredFrom: startsAt,
          preferredTo: new Date(startsAt.getTime() + 2 * 3_600_000),
        },
        select: { id: true },
      });
    const wl = await entry();
    // Its own entry for the complement, so a regression that lets A delete
    // the first one cannot make the complement fail too.
    const wl2 = await entry();
    return {
      ...out,
      locB: loc.id,
      branchB: branch.id,
      staffB: staff.id,
      apptB: appt.id,
      waitlistB: wl.id,
      waitlistB2: wl2.id,
    };
  });
  Object.assign(fx, seeded);
});

afterAll(async () => {
  // Children first, the ones a regression would have touched included
  // (feedback: cleanup must survive the regression it tests). The organisations
  // are archived, not deleted: audit rows reference them and are append-only.
  await withoutRls(async (tx) => {
    for (const organizationId of [fx.orgA, fx.orgB].filter(Boolean)) {
      await tx.notification.deleteMany({ where: { organizationId } });
      await tx.waitlist.deleteMany({ where: { organizationId } });
      await tx.appointment.deleteMany({ where: { organizationId } });
      await tx.staff.deleteMany({ where: { organizationId } });
      await tx.customer.deleteMany({ where: { organizationId } });
      await tx.location.deleteMany({ where: { organizationId } });
      await tx.organization.update({
        where: { id: organizationId },
        data: { status: 'archived' },
      });
    }
  });
});

beforeEach(() => {
  __clearAuthContextCache();
});

describe('DEF-08: the authorisation resolvers name the organisation, not only RLS', () => {
  it('the fixture is real: without RLS, organisation B resolves its own rows', async () => {
    // The complement of every refusal below. If this failed, a refusal would
    // prove nothing (the row would simply not exist).
    expect(await resolveAppointmentResource(fx.apptB, fx.orgB)).toEqual({
      organizationId: fx.orgB,
      branchId: fx.branchB,
      ownerUserId: fx.ownerB,
    });
    expect(await resolveBookingOwner(fx.apptB, fx.orgB)).toBe(fx.ownerB);
    expect(await resolveStaffResource(fx.staffB, fx.orgB)).toEqual({
      organizationId: fx.orgB,
      branchId: fx.branchB,
      ownerUserId: fx.ownerB,
    });
    expect(await resolveWaitlistResource(fx.waitlistB, fx.orgB)).toEqual({
      organizationId: fx.orgB,
      branchId: fx.branchB,
      ownerUserId: fx.ownerB,
    });
  });

  it("without RLS, organisation A does not resolve organisation B's rows as its own", async () => {
    expect(await resolveAppointmentResource(fx.apptB, fx.orgA)).toBeNull();
    expect(await resolveBookingOwner(fx.apptB, fx.orgA)).toBeNull();
    expect(await resolveStaffResource(fx.staffB, fx.orgA)).toBeNull();
    expect(await resolveWaitlistResource(fx.waitlistB, fx.orgA)).toBeNull();
  });

  it('a branch id from another organisation maps to no location (scopedLocationIds)', async () => {
    const ctxFor = (activeOrganizationId: string) =>
      ({
        activeOrganizationId,
        branchIds: new Set([fx.branchB]),
        permissions: new Set([perm('booking.read:branch')]),
      }) as unknown as AuthContext;
    // Complement: in its own organisation the branch maps to its location.
    expect(await scopedLocationIds(ctxFor(fx.orgB), 'booking.read')).toEqual([fx.locB]);
    // A JWT carrying B's branch id while active in A must reach nothing.
    expect(await scopedLocationIds(ctxFor(fx.orgA), 'booking.read')).toEqual([]);
  });

  it("PATCH /api/appointments/[id]: A's owner cannot cancel B's appointment, even without RLS", async () => {
    await signInAs(fx.ownerA, fx.orgA);
    const res = await routeAppointment.PATCH(
      req(`http://localhost/api/appointments/${fx.apptB}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      }),
      { params: Promise.resolve({ id: fx.apptB }) },
    );
    expect(res.status).toBe(404);
    const row = await unsafePrismaAdmin.appointment.findUniqueOrThrow({
      where: { id: fx.apptB },
      select: { status: true },
    });
    expect(row.status).toBe('confirmed');
    // Nothing was audited against B by A's request.
    expect(
      await unsafePrismaAdmin.auditLog.count({
        where: { organizationId: fx.orgB, actorUserId: fx.ownerA },
      }),
    ).toBe(0);
  });

  it("DELETE /api/waitlist/[id]: A's owner cannot remove B's entry, even without RLS", async () => {
    await signInAs(fx.ownerA, fx.orgA);
    const res = await routeWaitlist.DELETE(
      new Request(`http://localhost/api/waitlist/${fx.waitlistB}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: fx.waitlistB }) },
    );
    expect(res.status).toBe(404);
    expect(await unsafePrismaAdmin.waitlist.count({ where: { id: fx.waitlistB } })).toBe(1);
  });

  it("complement: B's owner, through the same routes and without RLS, is allowed", async () => {
    // Proves the refusals above come from the organisation check, not from
    // the routes failing for some other reason when RLS is absent.
    await signInAs(fx.ownerB, fx.orgB);
    const del = await routeWaitlist.DELETE(
      new Request(`http://localhost/api/waitlist/${fx.waitlistB2}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: fx.waitlistB2 }) },
    );
    expect(del.status).toBe(200);
    expect(await unsafePrismaAdmin.waitlist.count({ where: { id: fx.waitlistB2 } })).toBe(0);
  });
});
