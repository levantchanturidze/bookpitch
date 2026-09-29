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
// Pages read the active location from a cookie; the test chooses it.
const { locationMock } = vi.hoisted(() => ({ locationMock: vi.fn() }));
vi.mock('@/lib/active-location', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/active-location')>('@/lib/active-location');
  return { ...actual, loadLocationsForOrg: locationMock };
});

const { withoutRls } = await import('@/lib/db');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { ForbiddenError } = await import('@/lib/auth');
const {
  buildAuthContext,
  can,
  scopedLocationIds,
  resolveAppointmentResource,
  resolveWaitlistResource,
} = await import('@/lib/rbac');
const appointmentsRoute = await import('@/app/api/appointments/route');
const appointmentRoute = await import('@/app/api/appointments/[id]/route');
const waitlistRoute = await import('@/app/api/waitlist/route');
const waitlistEntryRoute = await import('@/app/api/waitlist/[id]/route');
const sendNowRoute = await import('@/app/api/reminders/send-now/route');
const availabilityRoute = await import('@/app/api/admin/staff/[id]/availability/route');
const { fetchAvailableSlotsAction } = await import('@/components/scheduler/actions');
const schedulerPage = await import('@/app/(app)/scheduler/page');
const waitlistPage = await import('@/app/(app)/waitlist/page');
const remindersPage = await import('@/app/(app)/reminders/page');
const billingPage = await import('@/app/(app)/billing/page');

import type { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// Branch scoping, end to end — the regression suite for
// docs/scoped-rbac-assumption-audit.md §3, through the REAL routes, pages,
// actions and resolvers, against real rows in TWO locations.
//
// THIS FILE WAS REWRITTEN ON 2026-09-29, deliberately, and its central premise
// is INVERTED. It used to assert that "unrestricted roles (FRONT_DESK with
// empty branchIds) keep org-wide reach". That was the implementation's
// documented contract and the specification's opposite (§10: `:branch` is
// `ctx.branchIds.includes(resource.branchId)`; §2.3 scenario 4). An empty set
// now means NO reach: zero rows in every list, deny on every concrete resource.
//
// The previous version also could not fail:
//   • its fixture org had ONE location and no appointments or waitlist rows,
//     so "every returned row is in scope" looped over nothing;
//   • its "out-of-scope locationId → 400" asked for 2020..2100, which the
//     range check refuses before the scope check runs — an IN-scope location
//     returned the same 400 (audit probe P2).
// Every list assertion below is therefore an EXACT set, the fixture puts rows
// in both locations, and each refusal has its allow twin beside it.
//
// The four regression cases the review asked for, and where they live:
//   empty branch set → zero list rows ............. "an EMPTY branch set"
//   populated set → only assigned-branch rows ..... "a POPULATED branch set"
//   concrete resource in an assigned branch → allow   "concrete resources"
//   concrete resource outside it → deny ............. "concrete resources"
// -----------------------------------------------------------------------------

type Fx = {
  orgId: string;
  locA: { id: string; name: string; type: 'clinic'; timezone: string };
  locB: { id: string; name: string; type: 'salon'; timezone: string };
  branchA: string;
  branchB: string;
  users: Record<'owner' | 'fdNone' | 'fdA' | 'mgrA' | 'prov', string>;
  memberships: Record<'owner' | 'fdNone' | 'fdA' | 'mgrA' | 'prov', string>;
  staffA: string;
  staffB: string;
  serviceA: string;
  serviceB: string;
  customer: string;
  apA: string;
  apB: string;
  soonA: string;
  soonB: string;
  waitlist: Record<'locA' | 'locB' | 'staffA' | 'staffB' | 'svcA' | 'svcB' | 'org', string>;
};
let fx: Fx;

const MONTH = '2030-03';
const FAR_A = new Date('2030-03-05T06:00:00.000Z');

function get(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}
function jsonReq(url: string, method: string, body: unknown): NextRequest {
  return new Request(url, {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as unknown as NextRequest;
}
async function as(who: keyof Fx['users']) {
  authMock.mockResolvedValue(await mockJwt(fx.users[who], fx.orgId));
}
async function ctxOf(who: keyof Fx['users']) {
  return (await buildAuthContext(fx.users[who], fx.memberships[who]))!;
}
const MARCH = `from=${encodeURIComponent('2030-03-01T00:00:00.000Z')}&to=${encodeURIComponent('2030-03-31T00:00:00.000Z')}`;

async function listAppointmentIds(query = MARCH): Promise<{ status: number; ids: string[] }> {
  const res = await appointmentsRoute.GET(get(`http://x/api/appointments?${query}`));
  if (res.status !== 200) return { status: res.status, ids: [] };
  const body = (await res.json()) as { appointments: Array<{ id: string }> };
  return { status: 200, ids: body.appointments.map((a) => a.id).sort() };
}
async function listWaitlistIds(): Promise<string[]> {
  const res = await waitlistRoute.GET();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { waitlist: Array<{ id: string }> };
  return body.waitlist.map((w) => w.id).sort();
}
const sorted = (xs: string[]) => [...xs].sort();

/** The first prop named `key` anywhere in a rendered server-component tree. */
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
function activeIs(loc: Fx['locA'] | Fx['locB']) {
  locationMock.mockResolvedValue({ locations: [fx.locA, fx.locB], active: loc });
}

beforeAll(async () => {
  const ts = Date.now();
  const soon = new Date(Math.ceil((Date.now() + 2 * 3_600_000) / 60_000) * 60_000);
  fx = await withoutRls(async (tx) => {
    const role = async (key: string) =>
      (
        await tx.role.findFirstOrThrow({
          where: { key, organizationId: null },
          select: { id: true },
        })
      ).id;
    const [rOwner, rFd, rMgr, rProv] = await Promise.all([
      role('ORG_OWNER'),
      role('FRONT_DESK'),
      role('BRANCH_MANAGER'),
      role('PROVIDER'),
    ]);
    const org = await tx.organization.create({ data: { name: `BS Org ${ts}` } });
    const user = (tag: string) =>
      tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `bs-${tag}-${ts}@bookpitch.dev`,
          email: `bs-${tag}-${ts}@bookpitch.dev`,
        },
        select: { id: true },
      });
    const u = {
      owner: (await user('owner')).id,
      fdNone: (await user('fdnone')).id,
      fdA: (await user('fda')).id,
      mgrA: (await user('mgra')).id,
      prov: (await user('prov')).id,
    };
    const member = (
      userId: string,
      legacy: 'owner' | 'receptionist' | 'practitioner',
      roleId: string,
    ) =>
      tx.membership.create({
        data: { organizationId: org.id, userId, role: legacy, roleId },
        select: { id: true },
      });
    const m = {
      owner: (await member(u.owner, 'owner', rOwner)).id,
      fdNone: (await member(u.fdNone, 'receptionist', rFd)).id,
      fdA: (await member(u.fdA, 'receptionist', rFd)).id,
      mgrA: (await member(u.mgrA, 'receptionist', rMgr)).id,
      prov: (await member(u.prov, 'practitioner', rProv)).id,
    };

    // Two locations; the locations → branches trigger gives each its branch.
    const locA = await tx.location.create({
      data: { organizationId: org.id, type: 'clinic', name: 'BS A' },
    });
    const locB = await tx.location.create({
      data: { organizationId: org.id, type: 'salon', name: 'BS B' },
    });
    const branchOf = async (locationId: string) =>
      (await tx.branch.findFirstOrThrow({ where: { legacyLocationId: locationId } })).id;
    const branchA = await branchOf(locA.id);
    const branchB = await branchOf(locB.id);

    await tx.membershipBranch.createMany({
      data: [
        { membershipId: m.fdA, branchId: branchA },
        { membershipId: m.mgrA, branchId: branchA },
      ],
    });

    const staffA = await tx.staff.create({
      data: {
        organizationId: org.id,
        locationId: locA.id,
        userId: u.prov, // the provider's own performer record
        name: 'BS Staff A',
        roleTitle: 'Clinician',
      },
    });
    const staffB = await tx.staff.create({
      data: {
        organizationId: org.id,
        locationId: locB.id,
        name: 'BS Staff B',
        roleTitle: 'Stylist',
      },
    });
    const serviceA = await tx.service.create({
      data: {
        organizationId: org.id,
        locationId: locA.id,
        name: 'BS Svc A',
        price: 10,
        durationMinutes: 30,
      },
    });
    const serviceB = await tx.service.create({
      data: {
        organizationId: org.id,
        locationId: locB.id,
        name: 'BS Svc B',
        price: 10,
        durationMinutes: 30,
      },
    });
    const customer = await tx.customer.create({
      data: { organizationId: org.id, name: 'BS Customer', email: `bs-${ts}@example.invalid` },
    });

    const appt = (locationId: string, staffId: string, startsAt: Date) =>
      tx.appointment.create({
        data: {
          organizationId: org.id,
          locationId,
          customerId: customer.id,
          staffId,
          serviceName: 'BS Service',
          price: 10,
          status: 'confirmed',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        },
        select: { id: true },
      });
    const apA = (await appt(locA.id, staffA.id, FAR_A)).id;
    const apB = (await appt(locB.id, staffB.id, FAR_A)).id;
    const soonA = (await appt(locA.id, staffA.id, soon)).id;
    const soonB = (await appt(locB.id, staffB.id, soon)).id;
    for (const appointmentId of [soonA, soonB]) {
      await tx.messageLog.create({
        data: {
          organizationId: org.id,
          appointmentId,
          channel: 'email',
          toAddress: `bs-${ts}@example.invalid`,
          body: 'BS reminder',
          state: 'sent',
        },
      });
    }

    const wl = (data: { locationId?: string; staffId?: string; serviceId?: string }) =>
      tx.waitlist.create({
        data: {
          organizationId: org.id,
          customerId: customer.id,
          preferredFrom: new Date('2030-04-01T00:00:00Z'),
          preferredTo: new Date('2030-04-02T00:00:00Z'),
          ...data,
        },
        select: { id: true },
      });
    const waitlist = {
      locA: (await wl({ locationId: locA.id })).id,
      locB: (await wl({ locationId: locB.id })).id,
      staffA: (await wl({ staffId: staffA.id })).id,
      staffB: (await wl({ staffId: staffB.id })).id,
      svcA: (await wl({ serviceId: serviceA.id })).id,
      svcB: (await wl({ serviceId: serviceB.id })).id,
      org: (await wl({})).id,
    };

    return {
      orgId: org.id,
      locA: { id: locA.id, name: locA.name, type: 'clinic' as const, timezone: locA.timezone },
      locB: { id: locB.id, name: locB.name, type: 'salon' as const, timezone: locB.timezone },
      branchA,
      branchB,
      users: u,
      memberships: m,
      staffA: staffA.id,
      staffB: staffB.id,
      serviceA: serviceA.id,
      serviceB: serviceB.id,
      customer: customer.id,
      apA,
      apB,
      soonA,
      soonB,
      waitlist,
    };
  });
});

afterAll(async () => {
  if (!fx) return;
  const orgId = fx.orgId;
  await withoutRls(async (tx) => {
    await tx.waitlist.deleteMany({ where: { organizationId: orgId } });
    await tx.messageLog.deleteMany({ where: { organizationId: orgId } });
    await tx.appointment.deleteMany({ where: { organizationId: orgId } });
    await tx.customer.deleteMany({ where: { organizationId: orgId } });
    await tx.service.deleteMany({ where: { organizationId: orgId } });
    await tx.staff.deleteMany({ where: { organizationId: orgId } });
    await tx.location.deleteMany({ where: { organizationId: orgId } });
    await tx.membership.deleteMany({ where: { organizationId: orgId } });
    await tx.organization.updateMany({ where: { id: orgId }, data: { ownerUserId: null } });
  });
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs([orgId]);
  await withoutRls(async (tx) => {
    await tx.appUser.deleteMany({ where: { id: { in: Object.values(fx.users) } } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
});

beforeEach(() => {
  authMock.mockReset();
  locationMock.mockReset();
  __clearAuthContextCache();
  // Reminder sends go to the mock adapters, which contact no one.
  vi.stubEnv('EMAIL_PROVIDER', 'mock');
  vi.stubEnv('SMS_PROVIDER', 'mock');
});

// -----------------------------------------------------------------------------
describe('an EMPTY branch set → zero rows, on every list path', () => {
  it('scopedLocationIds returns [] — nothing, never "no filter"', async () => {
    expect(await scopedLocationIds(await ctxOf('fdNone'), 'booking.read')).toEqual([]);
  });

  it('GET /api/appointments returns no rows', async () => {
    await as('fdNone');
    expect(await listAppointmentIds()).toEqual({ status: 200, ids: [] });
  });

  it('GET /api/appointments refuses an explicit locationId it has no branch for', async () => {
    await as('fdNone');
    const res = await appointmentsRoute.GET(
      get(`http://x/api/appointments?${MARCH}&locationId=${fx.locA.id}`),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/outside your branch scope/);
  });

  it('GET /api/waitlist returns no rows — not even the org-level one', async () => {
    await as('fdNone');
    expect(await listWaitlistIds()).toEqual([]);
  });

  it('/scheduler still renders, with no appointments', async () => {
    await as('fdNone');
    activeIs(fx.locA);
    const el = await schedulerPage.default({ searchParams: Promise.resolve({ month: MONTH }) });
    expect(findProp<unknown[]>(el, 'appointments')).toEqual([]);
  });

  it('/waitlist renders, with no rows', async () => {
    await as('fdNone');
    const el = await waitlistPage.default();
    expect(findProp<unknown[]>(el, 'rows')).toEqual([]);
  });

  it('/reminders shows no upcoming appointment and no message log', async () => {
    await as('fdNone');
    activeIs(fx.locA);
    const el = await remindersPage.default();
    expect(findProp<unknown[]>(el, 'upcoming')).toEqual([]);
    expect(findProp<unknown[]>(el, 'log')).toEqual([]);
  });

  it('/billing lists nothing', async () => {
    await as('fdNone');
    activeIs(fx.locA);
    const el = await billingPage.default();
    expect(findProp<unknown[]>(el, 'rows')).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('a POPULATED branch set → only the assigned branch', () => {
  it('GET /api/appointments returns exactly the branch-A appointment', async () => {
    await as('fdA');
    expect(await listAppointmentIds()).toEqual({ status: 200, ids: [fx.apA] });
  });

  it('an explicit locationId outside the set is refused; inside it is served', async () => {
    await as('fdA');
    const out = await appointmentsRoute.GET(
      get(`http://x/api/appointments?${MARCH}&locationId=${fx.locB.id}`),
    );
    expect(out.status).toBe(400);
    expect(((await out.json()) as { error: string }).error).toMatch(/outside your branch scope/);
    await as('fdA');
    expect(await listAppointmentIds(`${MARCH}&locationId=${fx.locA.id}`)).toEqual({
      status: 200,
      ids: [fx.apA],
    });
  });

  it('GET /api/waitlist returns exactly the rows attributed to branch A (D2)', async () => {
    await as('fdA');
    expect(await listWaitlistIds()).toEqual(
      sorted([fx.waitlist.locA, fx.waitlist.staffA, fx.waitlist.svcA]),
    );
  });

  it('/waitlist shows exactly what GET /api/waitlist returns', async () => {
    await as('fdA');
    const el = await waitlistPage.default();
    const rows = findProp<Array<{ id: string }>>(el, 'rows') ?? [];
    expect(sorted(rows.map((r) => r.id))).toEqual(
      sorted([fx.waitlist.locA, fx.waitlist.staffA, fx.waitlist.svcA]),
    );
  });

  it('/scheduler shows branch A at location A, and nothing at location B', async () => {
    await as('fdA');
    activeIs(fx.locA);
    const atA = await schedulerPage.default({ searchParams: Promise.resolve({ month: MONTH }) });
    expect((findProp<Array<{ id: string }>>(atA, 'appointments') ?? []).map((a) => a.id)).toEqual([
      fx.apA,
    ]);
    __clearAuthContextCache();
    await as('fdA');
    activeIs(fx.locB);
    const atB = await schedulerPage.default({ searchParams: Promise.resolve({ month: MONTH }) });
    expect(findProp<unknown[]>(atB, 'appointments')).toEqual([]);
  });

  it('/reminders shows only branch A — upcoming list and message log alike', async () => {
    await as('fdA');
    activeIs(fx.locA);
    const atA = await remindersPage.default();
    expect((findProp<Array<{ id: string }>>(atA, 'upcoming') ?? []).map((a) => a.id)).toEqual([
      fx.soonA,
    ]);
    const logA = findProp<Array<{ appointmentId: string }>>(atA, 'log') ?? [];
    expect(logA.map((l) => l.appointmentId)).toEqual([fx.soonA]);

    __clearAuthContextCache();
    await as('fdA');
    activeIs(fx.locB);
    const atB = await remindersPage.default();
    expect(findProp<unknown[]>(atB, 'upcoming')).toEqual([]);
    // The log spans the caller's branches, not the active location.
    const logB = findProp<Array<{ appointmentId: string }>>(atB, 'log') ?? [];
    expect(logB.map((l) => l.appointmentId)).toEqual([fx.soonA]);
  });

  it('/billing lists branch A at location A, and nothing at location B', async () => {
    await as('fdA');
    activeIs(fx.locA);
    const atA = await billingPage.default();
    expect(sorted((findProp<Array<{ id: string }>>(atA, 'rows') ?? []).map((r) => r.id))).toEqual(
      sorted([fx.apA, fx.soonA]),
    );
    __clearAuthContextCache();
    await as('fdA');
    activeIs(fx.locB);
    expect(findProp<unknown[]>(await billingPage.default(), 'rows')).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('concrete resources — in an assigned branch allowed, outside it refused', () => {
  async function notesOf(id: string) {
    return (await withoutRls((tx) => tx.appointment.findUniqueOrThrow({ where: { id } }))).notes;
  }
  async function patch(id: string, notes: string) {
    return appointmentRoute.PATCH(jsonReq(`http://x/api/appointments/${id}`, 'PATCH', { notes }), {
      params: Promise.resolve({ id }),
    });
  }

  it('PATCH an appointment in branch A → 200 and written', async () => {
    await as('fdA');
    expect((await patch(fx.apA, 'bs-in-scope')).status).toBe(200);
    expect(await notesOf(fx.apA)).toBe('bs-in-scope');
  });

  it('PATCH an appointment in branch B → 403 and untouched', async () => {
    const before = await notesOf(fx.apB);
    await as('fdA');
    expect((await patch(fx.apB, 'bs-out-of-scope')).status).toBe(403);
    expect(await notesOf(fx.apB)).toBe(before);
  });

  it('a member with NO branches is refused even in branch A', async () => {
    const before = await notesOf(fx.apA);
    await as('fdNone');
    expect((await patch(fx.apA, 'bs-no-branches')).status).toBe(403);
    expect(await notesOf(fx.apA)).toBe(before);
  });

  it('waitlist DELETE: every branch-A attribution allowed, every other refused (D2)', async () => {
    // Fresh rows per case, so the list assertions above keep their fixture.
    const make = (data: { locationId?: string; staffId?: string; serviceId?: string }) =>
      withoutRls((tx) =>
        tx.waitlist.create({
          data: {
            organizationId: fx.orgId,
            customerId: fx.customer,
            preferredFrom: new Date('2030-05-01T00:00:00Z'),
            preferredTo: new Date('2030-05-02T00:00:00Z'),
            ...data,
          },
          select: { id: true },
        }),
      );
    const del = async (id: string) => {
      await as('fdA');
      return (
        await waitlistEntryRoute.DELETE(new Request(`http://x/api/waitlist/${id}`), {
          params: Promise.resolve({ id }),
        })
      ).status;
    };
    const exists = async (id: string) =>
      (await withoutRls((tx) => tx.waitlist.count({ where: { id } }))) === 1;

    for (const data of [
      { locationId: fx.locA.id },
      { staffId: fx.staffA },
      { serviceId: fx.serviceA },
    ]) {
      const { id } = await make(data);
      expect(await del(id), JSON.stringify(data)).toBe(200);
      expect(await exists(id)).toBe(false);
    }
    for (const data of [
      { locationId: fx.locB.id },
      { staffId: fx.staffB },
      { serviceId: fx.serviceB },
      {}, // org-level: reachable only with an :org grant
    ]) {
      const { id } = await make(data);
      expect(await del(id), JSON.stringify(data)).toBe(403);
      expect(await exists(id)).toBe(true);
      await withoutRls((tx) => tx.waitlist.delete({ where: { id } }));
    }
  });

  it('send-now: branch A sends, branch B is refused and sends nothing', async () => {
    // Fresh appointments with no message history: per-channel idempotency would
    // otherwise let the allow case add nothing, and "no new rows" would prove
    // nothing about the refusal either.
    const at = new Date(Math.ceil((Date.now() + 5 * 3_600_000) / 60_000) * 60_000);
    const fresh = (locationId: string, staffId: string) =>
      withoutRls((tx) =>
        tx.appointment.create({
          data: {
            organizationId: fx.orgId,
            locationId,
            customerId: fx.customer,
            staffId,
            serviceName: 'BS send-now',
            price: 10,
            status: 'confirmed',
            startsAt: at,
            endsAt: new Date(at.getTime() + 30 * 60_000),
          },
          select: { id: true },
        }),
      );
    const inA = (await fresh(fx.locA.id, fx.staffA)).id;
    const inB = (await fresh(fx.locB.id, fx.staffB)).id;
    const count = (appointmentId: string) =>
      withoutRls((tx) => tx.messageLog.count({ where: { appointmentId } }));
    const send = async (appointmentId: string) => {
      await as('fdA');
      return (
        await sendNowRoute.POST(
          jsonReq('http://x/api/reminders/send-now', 'POST', { appointmentId }),
        )
      ).status;
    };
    expect(await send(inA)).toBe(200);
    expect(await count(inA)).toBeGreaterThan(0);
    expect(await send(inB)).toBe(403);
    expect(await count(inB)).toBe(0);
  });

  it('staff hours (staff.schedule.manage:branch): branch A written, branch B refused', async () => {
    const windowsOf = (staffId: string) =>
      withoutRls((tx) => tx.staffAvailability.count({ where: { staffId } }));
    const put = async (staffId: string) => {
      await as('mgrA');
      return (
        await availabilityRoute.PUT(
          jsonReq(`http://x/api/admin/staff/${staffId}/availability`, 'PUT', {
            windows: [{ weekday: 2, startTime: '09:00', endTime: '10:00' }],
          }),
          { params: Promise.resolve({ id: staffId }) },
        )
      ).status;
    };
    const beforeB = await windowsOf(fx.staffB);
    expect(await put(fx.staffA)).toBe(200);
    expect(await windowsOf(fx.staffA)).toBe(1);
    expect(await put(fx.staffB)).toBe(403);
    expect(await windowsOf(fx.staffB)).toBe(beforeB);
  });

  it('slot lookup reads branch A, and is refused branch B', async () => {
    await as('fdA');
    expect(Array.isArray(await fetchAvailableSlotsAction(fx.staffA, '2030-03-06', 30))).toBe(true);
    await as('fdA');
    await expect(fetchAvailableSlotsAction(fx.staffB, '2030-03-06', 30)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

// -----------------------------------------------------------------------------
describe('the id space — resolvers supply BRANCH ids (audit §3.4, probe P1)', () => {
  it('an appointment resolves to the branch of its location, and it matches', async () => {
    const resource = await resolveAppointmentResource(fx.apA, fx.orgId);
    expect(resource?.branchId).toBe(fx.branchA);
    expect(resource?.branchId).not.toBe(fx.locA.id);
    const ctx = await ctxOf('fdA');
    expect(ctx.branchIds.has(fx.branchA)).toBe(true);
    expect(can(ctx, 'booking.update', resource!)).toBe(true);
  });

  it('D2 — the list and the concrete resolver agree on every waitlist row', async () => {
    await as('fdA');
    const listed = new Set(await listWaitlistIds());
    const ctx = await ctxOf('fdA');
    for (const [label, id] of Object.entries(fx.waitlist)) {
      const resource = await resolveWaitlistResource(id, fx.orgId);
      expect(resource, label).not.toBeNull();
      expect(can(ctx, 'booking.update', resource!), label).toBe(listed.has(id));
    }
  });
});

// -----------------------------------------------------------------------------
describe('scopes that must keep working', () => {
  it(':org — the owner sees both branches and the org-level waitlist row', async () => {
    await as('owner');
    expect(await listAppointmentIds()).toEqual({ status: 200, ids: sorted([fx.apA, fx.apB]) });
    await as('owner');
    expect(await listWaitlistIds()).toEqual(sorted(Object.values(fx.waitlist)));
  });

  it(':own — the provider sees and changes only the appointment on their own staff record', async () => {
    await as('prov');
    expect(await listAppointmentIds()).toEqual({ status: 200, ids: [fx.apA] });
    const patch = async (id: string) => {
      await as('prov');
      return (
        await appointmentRoute.PATCH(
          jsonReq(`http://x/api/appointments/${id}`, 'PATCH', { notes: 'bs-own' }),
          { params: Promise.resolve({ id }) },
        )
      ).status;
    };
    expect(await patch(fx.apA)).toBe(200);
    expect(await patch(fx.apB)).toBe(403);
  });
});
