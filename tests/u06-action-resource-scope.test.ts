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

const { withoutRls } = await import('@/lib/db');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { ForbiddenError, InvalidInputError } = await import('@/lib/auth');
const { createLocation, createStaff } = await import('@/lib/admin');
const { sendNowAction } = await import('@/components/reminders/actions');
const { setAvailabilityAction } = await import('@/components/settings/actions');
const availabilityRoute = await import('@/app/api/admin/staff/[id]/availability/route');

import type { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// U-06 — two Server Actions authorised the ORGANISATION, then acted on an id.
//
// Found by the scoped-RBAC assumption audit on 2026-09-28
// (docs/scoped-rbac-assumption-audit.md §3.6), with a local runtime probe.
//
//   sendNowAction          requirePermission('booking.update', { organizationId })
//                          → sendNowForSession(any appointment in the org)
//   setAvailabilityAction  requirePermission('staff.schedule.manage', { organizationId })
//                          → setAvailability(any staff id in the org)
//
// Naming no resource is can()'s LIST mode, which grants `:own` so that a
// PROVIDER can list anything at all. A mutation that takes that path is
// authorised against nothing: a PROVIDER could fire customer reminders for any
// appointment and rewrite any colleague's working hours. This is U-05's shape
// exactly. U-05 fixed both API siblings (app/api/reminders/send-now,
// app/api/admin/staff/[id]/availability), and those return 403 — the actions
// beside them were never touched.
//
// Every assertion that matters here is DATABASE state — message_log rows,
// availability windows — not only the refusal. A thrown ForbiddenError proves
// the guard fired; an unchanged row proves nothing was done anyway.
//
// Staff.userId is written directly below. The product has no staff↔member link
// flow yet (the scoped-RBAC change adds it); the column is the state that flow
// will produce, and without it the ALLOW half of the complement cannot exist.
// -----------------------------------------------------------------------------

type Fixture = {
  orgId: string;
  foreignOrgId: string;
  ownerId: string;
  providerId: string;
  staffMine: string;
  staffTheirs: string;
  staffUnlinked: string;
  apptMine: string;
  apptTheirs: string;
  apptUnlinked: string;
  apptForeign: string;
};
let fx: Fixture;

const WINDOWS_BEFORE = [{ weekday: 2, startTime: '09:00', endTime: '17:00' }];
const WINDOWS_ATTEMPT = [{ weekday: 6, startTime: '06:00', endTime: '07:00' }];

function sendNowForm(appointmentId: string): FormData {
  const fd = new FormData();
  fd.set('appointmentId', appointmentId);
  return fd;
}

async function signInAs(userId: string, orgId: string) {
  authMock.mockResolvedValue(await mockJwt(userId, orgId));
}

async function messageLogCount(appointmentId: string): Promise<number> {
  return withoutRls((tx) => tx.messageLog.count({ where: { appointmentId } }));
}

async function windowsOf(staffId: string) {
  const rows = await withoutRls((tx) =>
    tx.staffAvailability.findMany({
      where: { staffId },
      select: { weekday: true, startTime: true, endTime: true },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    }),
  );
  return rows.map((r) => ({
    weekday: r.weekday,
    startTime: r.startTime.toISOString().slice(11, 16),
    endTime: r.endTime.toISOString().slice(11, 16),
  }));
}

beforeAll(async () => {
  const ts = Date.now();
  const base = await withoutRls(async (tx) => {
    const ownerRole = await tx.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
      select: { id: true },
    });
    const providerRole = await tx.role.findFirstOrThrow({
      where: { key: 'PROVIDER', organizationId: null },
      select: { id: true },
    });
    const org = await tx.organization.create({ data: { name: `U06 Org ${ts}` } });
    const foreign = await tx.organization.create({ data: { name: `U06 Foreign ${ts}` } });
    const owner = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: `u06-owner-${ts}@bookpitch.dev`,
        email: `u06-owner-${ts}@bookpitch.dev`,
      },
    });
    const provider = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: `u06-provider-${ts}@bookpitch.dev`,
        email: `u06-provider-${ts}@bookpitch.dev`,
      },
    });
    const ownerM = await tx.membership.create({
      data: { organizationId: org.id, userId: owner.id, role: 'owner', roleId: ownerRole.id },
    });
    await tx.membership.create({
      data: {
        organizationId: org.id,
        userId: provider.id,
        role: 'practitioner',
        roleId: providerRole.id,
      },
    });
    const foreignOwnerM = await tx.membership.create({
      data: { organizationId: foreign.id, userId: owner.id, role: 'owner', roleId: ownerRole.id },
    });
    const customer = await tx.customer.create({
      data: {
        organizationId: org.id,
        name: 'U06 Customer',
        email: `u06-customer-${ts}@example.invalid`,
        phone: '+995555000106',
      },
    });
    const foreignCustomer = await tx.customer.create({
      data: { organizationId: foreign.id, name: 'U06 Foreign Customer' },
    });
    return {
      orgId: org.id,
      foreignOrgId: foreign.id,
      ownerId: owner.id,
      providerId: provider.id,
      ownerMembershipId: ownerM.id,
      foreignOwnerMembershipId: foreignOwnerM.id,
      customerId: customer.id,
      foreignCustomerId: foreignCustomer.id,
      ts,
    };
  });

  const session = {
    organizationId: base.orgId,
    userId: base.ownerId,
    email: `u06-owner-${base.ts}@bookpitch.dev`,
    membershipId: base.ownerMembershipId,
  };
  const foreignSession = {
    ...session,
    organizationId: base.foreignOrgId,
    membershipId: base.foreignOwnerMembershipId,
  };

  const loc = await createLocation(session, {
    type: 'clinic',
    name: 'U06 Location',
    timezone: 'Asia/Tbilisi',
  });
  const foreignLoc = await createLocation(foreignSession, {
    type: 'clinic',
    name: 'U06 Foreign Location',
    timezone: 'Asia/Tbilisi',
  });
  const staff = async (name: string) =>
    (await createStaff(session, { locationId: loc.id, name, roleTitle: 'Clinician' })).id;
  const staffMine = await staff('U06 Mine');
  const staffTheirs = await staff('U06 Theirs');
  const staffUnlinked = await staff('U06 Unlinked');
  const foreignStaff = (
    await createStaff(foreignSession, {
      locationId: foreignLoc.id,
      name: 'U06 Foreign',
      roleTitle: 'Clinician',
    })
  ).id;

  const appts = await withoutRls(async (tx) => {
    // The state the (not yet built) link flow will produce. See the header.
    await tx.staff.update({ where: { id: staffMine }, data: { userId: base.providerId } });
    await tx.staff.update({ where: { id: staffTheirs }, data: { userId: base.ownerId } });

    for (const staffId of [staffMine, staffTheirs, staffUnlinked]) {
      await tx.staffAvailability.create({
        data: {
          staffId,
          weekday: WINDOWS_BEFORE[0].weekday,
          startTime: new Date(`1970-01-01T${WINDOWS_BEFORE[0].startTime}:00Z`),
          endTime: new Date(`1970-01-01T${WINDOWS_BEFORE[0].endTime}:00Z`),
          timeBasis: 'local',
        },
      });
    }

    const appt = (
      organizationId: string,
      locationId: string,
      customerId: string,
      staffId: string,
    ) =>
      tx.appointment.create({
        data: {
          organizationId,
          locationId,
          customerId,
          staffId,
          serviceName: 'U06 Service',
          price: 10,
          startsAt: new Date('2030-03-05T08:00:00.000Z'),
          endsAt: new Date('2030-03-05T08:30:00.000Z'),
          status: 'confirmed',
        },
        select: { id: true },
      });
    return {
      apptMine: (await appt(base.orgId, loc.id, base.customerId, staffMine)).id,
      apptTheirs: (await appt(base.orgId, loc.id, base.customerId, staffTheirs)).id,
      apptUnlinked: (await appt(base.orgId, loc.id, base.customerId, staffUnlinked)).id,
      apptForeign: (
        await appt(base.foreignOrgId, foreignLoc.id, base.foreignCustomerId, foreignStaff)
      ).id,
    };
  });

  fx = {
    orgId: base.orgId,
    foreignOrgId: base.foreignOrgId,
    ownerId: base.ownerId,
    providerId: base.providerId,
    staffMine,
    staffTheirs,
    staffUnlinked,
    ...appts,
  };
});

afterAll(async () => {
  if (!fx) return;
  const orgs = [fx.orgId, fx.foreignOrgId];
  await withoutRls((tx) => tx.appointment.deleteMany({ where: { organizationId: { in: orgs } } }));
  await withoutRls((tx) => tx.messageLog.deleteMany({ where: { organizationId: { in: orgs } } }));
  await withoutRls((tx) => tx.customer.deleteMany({ where: { organizationId: { in: orgs } } }));
  await withoutRls((tx) => tx.staff.deleteMany({ where: { organizationId: { in: orgs } } }));
  await withoutRls((tx) => tx.location.deleteMany({ where: { organizationId: { in: orgs } } }));
  await withoutRls(async (tx) => {
    await tx.membership.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.organization.updateMany({ where: { id: { in: orgs } }, data: { ownerUserId: null } });
  });
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs(orgs);
  await withoutRls((tx) =>
    tx.appUser.deleteMany({ where: { id: { in: [fx.ownerId, fx.providerId] } } }),
  );
  await withoutRls((tx) => tx.organization.deleteMany({ where: { id: { in: orgs } } }));
});

beforeEach(() => {
  authMock.mockReset();
  __clearAuthContextCache();
  // Mock adapters contact no one and are refused in production. Pinned here so
  // a future .env.local can never turn this suite into a real send.
  vi.stubEnv('EMAIL_PROVIDER', 'mock');
  vi.stubEnv('SMS_PROVIDER', 'mock');
});

describe('U-06 — sendNowAction authorises against the appointment it names', () => {
  it("REFUSES a PROVIDER sending for a colleague's appointment, and sends nothing", async () => {
    await signInAs(fx.providerId, fx.orgId);
    await expect(sendNowAction(sendNowForm(fx.apptTheirs))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await messageLogCount(fx.apptTheirs)).toBe(0);
  });

  it('REFUSES a PROVIDER on an appointment whose staff has no linked user (U-05 shape)', async () => {
    await signInAs(fx.providerId, fx.orgId);
    await expect(sendNowAction(sendNowForm(fx.apptUnlinked))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await messageLogCount(fx.apptUnlinked)).toBe(0);
  });

  it('ALLOWS the same PROVIDER on their own appointment — the complement', async () => {
    await signInAs(fx.providerId, fx.orgId);
    await sendNowAction(sendNowForm(fx.apptMine));
    expect(await messageLogCount(fx.apptMine)).toBeGreaterThan(0);
  });

  it('an :org owner still sends for any appointment in the organisation', async () => {
    await signInAs(fx.ownerId, fx.orgId);
    await sendNowAction(sendNowForm(fx.apptUnlinked));
    expect(await messageLogCount(fx.apptUnlinked)).toBeGreaterThan(0);
  });

  it('a cross-tenant id sends nothing, for a PROVIDER or an :org owner', async () => {
    // Refined by the scoped-RBAC change (C7), deliberately. U-06 shipped with
    // the action mirroring its route of the day — owner resolved, then the
    // check — so a PROVIDER got ForbiddenError here while the owner got "not
    // found". The action now resolves the appointment first, as PATCH does:
    // an id outside the organisation is "not found" to everyone holding
    // booking.update at all, which leaks nothing a role difference could. The
    // property this case exists for is unchanged: nothing is sent.
    await signInAs(fx.providerId, fx.orgId);
    await expect(sendNowAction(sendNowForm(fx.apptForeign))).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    __clearAuthContextCache();
    await signInAs(fx.ownerId, fx.orgId);
    await expect(sendNowAction(sendNowForm(fx.apptForeign))).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    expect(await messageLogCount(fx.apptForeign)).toBe(0);
  });
});

describe('U-06 — setAvailabilityAction authorises against the staff member it names', () => {
  it("REFUSES a PROVIDER rewriting a colleague's hours, and the hours are unchanged", async () => {
    await signInAs(fx.providerId, fx.orgId);
    const before = await windowsOf(fx.staffTheirs);
    const result = await setAvailabilityAction(fx.staffTheirs, WINDOWS_ATTEMPT);
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await windowsOf(fx.staffTheirs)).toEqual(before);
    expect(before).toEqual(WINDOWS_BEFORE);
  });

  it('REFUSES a PROVIDER on a staff row with no linked user, and the hours are unchanged', async () => {
    await signInAs(fx.providerId, fx.orgId);
    const result = await setAvailabilityAction(fx.staffUnlinked, WINDOWS_ATTEMPT);
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await windowsOf(fx.staffUnlinked)).toEqual(WINDOWS_BEFORE);
  });

  it('ALLOWS the same PROVIDER on their own staff row — the complement', async () => {
    await signInAs(fx.providerId, fx.orgId);
    const result = await setAvailabilityAction(fx.staffMine, WINDOWS_ATTEMPT);
    expect(result).toMatchObject({ ok: true });
    expect(await windowsOf(fx.staffMine)).toEqual(WINDOWS_ATTEMPT);
  });

  it('an :org owner still sets any staff member’s hours', async () => {
    await signInAs(fx.ownerId, fx.orgId);
    const result = await setAvailabilityAction(fx.staffUnlinked, WINDOWS_ATTEMPT);
    expect(result).toMatchObject({ ok: true });
    expect(await windowsOf(fx.staffUnlinked)).toEqual(WINDOWS_ATTEMPT);
  });

  it('the action and its API sibling give the same answer to the same PROVIDER', async () => {
    const put = (staffId: string) =>
      availabilityRoute.PUT(
        new Request(`http://x/api/admin/staff/${staffId}/availability`, {
          method: 'PUT',
          body: JSON.stringify({ windows: WINDOWS_ATTEMPT }),
          headers: { 'content-type': 'application/json' },
        }) as unknown as NextRequest,
        { params: Promise.resolve({ id: staffId }) },
      );
    await signInAs(fx.providerId, fx.orgId);
    expect((await put(fx.staffTheirs)).status).toBe(403);
    expect(await setAvailabilityAction(fx.staffTheirs, WINDOWS_ATTEMPT)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect((await put(fx.staffMine)).status).toBe(200);
    expect(await setAvailabilityAction(fx.staffMine, WINDOWS_ATTEMPT)).toMatchObject({ ok: true });
  });
});
