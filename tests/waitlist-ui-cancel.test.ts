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

// The fan-out's notification can be made to fail with a real failing
// STATEMENT (what aborts a PostgreSQL transaction), and only that one: the
// scheduler also writes its own "Appointment cancelled" notification, which
// must keep working for the failure policy to be observable.
const { faults } = vi.hoisted(() => ({ faults: { failWaitlistNotification: false } }));
vi.mock('@/lib/notifications', async () => {
  const actual = await vi.importActual<typeof import('@/lib/notifications')>('@/lib/notifications');
  return {
    ...actual,
    notifyEvent: async (...args: Parameters<typeof actual.notifyEvent>) => {
      if (faults.failWaitlistNotification && args[2].type === 'waitlist') {
        await args[0].$executeRawUnsafe('SELECT * FROM injected_missing_table_for_f5_test');
      }
      return actual.notifyEvent(...args);
    },
  };
});

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const { updateAppointmentAction } = await import('@/components/scheduler/actions');
const appointmentRoute = await import('@/app/api/appointments/[id]/route');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');

import type { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// F-5. docs/features-en.md documents "Auto-notify the waitlist when a slot is
// freed" as running "on cancel transition": matching pending entries are
// marked notified, each audited, and staff get one "Slot opened" notification.
// Only PATCH /api/appointments/[id] did it. The scheduler, where staff cancel,
// cancels through updateAppointmentAction, which never ran the fan-out, so
// from the product UI the waitlist never heard about a freed slot.
// -----------------------------------------------------------------------------

const stamp = Date.now();
const fx = { org: '', owner: '', loc: '', staff: '', otherStaff: '', customer: '' };
const DAY = (n: number) => new Date(Date.UTC(2031, 5, n)); // June 2031

async function appointment(day: number, staffId = fx.staff) {
  const startsAt = new Date(DAY(day).getTime() + 9 * 3_600_000);
  return (
    await withoutRls((tx) =>
      tx.appointment.create({
        data: {
          organizationId: fx.org,
          locationId: fx.loc,
          customerId: fx.customer,
          staffId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          serviceName: 'F5 consult',
          price: 10,
          status: 'confirmed',
        },
        select: { id: true },
      }),
    )
  ).id;
}

/** A pending entry wanting `staffId` any time on `day`. */
async function entry(day: number, staffId = fx.staff) {
  return (
    await withoutRls((tx) =>
      tx.waitlist.create({
        data: {
          organizationId: fx.org,
          customerId: fx.customer,
          staffId,
          preferredFrom: DAY(day),
          preferredTo: DAY(day + 1),
        },
        select: { id: true },
      }),
    )
  ).id;
}

/** Everything the fan-out leaves behind for one entry and one appointment. */
async function effects(entryId: string, appointmentId: string) {
  const row = await unsafePrismaAdmin.waitlist.findUniqueOrThrow({
    where: { id: entryId },
    select: { status: true, notifiedAt: true },
  });
  const audits = await unsafePrismaAdmin.auditLog.findMany({
    where: { organizationId: fx.org, entity: 'waitlist', entityId: entryId },
    select: { action: true, actorUserId: true, meta: true },
  });
  const bells = await unsafePrismaAdmin.notification.count({
    where: { organizationId: fx.org, type: 'waitlist' },
  });
  const appt = await unsafePrismaAdmin.appointment.findUniqueOrThrow({
    where: { id: appointmentId },
    select: { status: true },
  });
  return {
    status: row.status,
    notified: row.notifiedAt !== null,
    audits,
    bells,
    appt: appt.status,
  };
}

async function clearBells() {
  await unsafePrismaAdmin.notification.deleteMany({ where: { organizationId: fx.org } });
}

beforeAll(async () => {
  const seeded = await withoutRls(async (tx) => {
    const role = await tx.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
      select: { id: true },
    });
    const owner = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: `f5-${stamp}@bp.test`,
        email: `f5-${stamp}@bp.test`,
      },
      select: { id: true },
    });
    const org = await tx.organization.create({
      data: { name: `f5-ui-cancel-${stamp}`, status: 'active', ownerUserId: owner.id },
      select: { id: true },
    });
    await tx.membership.create({
      data: { organizationId: org.id, userId: owner.id, role: 'owner', roleId: role.id },
    });
    const loc = await tx.location.create({
      data: { organizationId: org.id, name: 'F5', type: 'clinic', timezone: 'UTC' },
      select: { id: true },
    });
    const staff = await tx.staff.create({
      data: { organizationId: org.id, locationId: loc.id, name: 'F5 Dr', roleTitle: 'GP' },
      select: { id: true },
    });
    const otherStaff = await tx.staff.create({
      data: { organizationId: org.id, locationId: loc.id, name: 'F5 Other', roleTitle: 'GP' },
      select: { id: true },
    });
    const customer = await tx.customer.create({
      data: { organizationId: org.id, name: 'F5 Customer', phone: '+995500000505' },
      select: { id: true },
    });
    return {
      org: org.id,
      owner: owner.id,
      loc: loc.id,
      staff: staff.id,
      otherStaff: otherStaff.id,
      customer: customer.id,
    };
  });
  Object.assign(fx, seeded);
});

afterAll(async () => {
  // Archived first: the deferred org-owner trigger refuses removing a live
  // organisation's owner membership. Children before parents.
  await withoutRls(async (tx) => {
    await tx.organization.update({ where: { id: fx.org }, data: { status: 'archived' } });
    await tx.notification.deleteMany({ where: { organizationId: fx.org } });
    await tx.waitlist.deleteMany({ where: { organizationId: fx.org } });
    await tx.appointment.deleteMany({ where: { organizationId: fx.org } });
    await tx.customer.deleteMany({ where: { organizationId: fx.org } });
    await tx.staff.deleteMany({ where: { organizationId: fx.org } });
    await tx.location.deleteMany({ where: { organizationId: fx.org } });
    await tx.membership.deleteMany({ where: { organizationId: fx.org } });
  });
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs([fx.org]);
  await withoutRls(async (tx) => {
    await tx.organization.deleteMany({ where: { id: fx.org } });
    await tx.appUser.deleteMany({ where: { id: fx.owner } });
  });
});

beforeEach(async () => {
  faults.failWaitlistNotification = false;
  await clearBells();
  __clearAuthContextCache();
  authMock.mockResolvedValue(await mockJwt(fx.owner, fx.org));
});

describe('F-5: a cancellation in the scheduler reaches the waitlist', () => {
  it('marks the matching entry notified, audits it, and rings once, exactly as the API does', async () => {
    const viaUi = { appt: await appointment(10), entry: await entry(10) };
    const viaApi = { appt: await appointment(11), entry: await entry(11) };
    const unrelated = await entry(10, fx.otherStaff); // another practitioner's waitlist

    const res = await updateAppointmentAction(viaUi.appt, { status: 'cancelled' });
    expect(res).toMatchObject({ ok: true });
    const ui = await effects(viaUi.entry, viaUi.appt);
    expect(ui).toEqual({
      status: 'notified',
      notified: true,
      audits: [
        {
          action: 'update',
          actorUserId: fx.owner,
          meta: { status: 'notified', appointmentId: viaUi.appt },
        },
      ],
      bells: 1,
      appt: 'cancelled',
    });
    // Only the entry the freed slot matches.
    expect((await effects(unrelated, viaUi.appt)).status).toBe('pending');

    // The API path, for comparison: the same effects, field for field.
    await clearBells();
    const apiRes = await appointmentRoute.PATCH(
      new Request(`http://localhost/api/appointments/${viaApi.appt}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      }) as unknown as NextRequest,
      { params: Promise.resolve({ id: viaApi.appt }) },
    );
    expect(apiRes.status).toBe(200);
    const api = await effects(viaApi.entry, viaApi.appt);
    expect({ ...api, audits: api.audits.map((a) => ({ ...a, meta: '<appt>' })) }).toEqual({
      ...ui,
      audits: ui.audits.map((a) => ({ ...a, meta: '<appt>' })),
    });
  });

  it('cancelling again notifies nobody twice', async () => {
    const appt = await appointment(14);
    const wanted = await entry(14);
    await updateAppointmentAction(appt, { status: 'cancelled' });
    await clearBells();
    const again = await updateAppointmentAction(appt, { status: 'cancelled' });
    expect(again).toMatchObject({ ok: true });
    const after = await effects(wanted, appt);
    expect(after.audits).toHaveLength(1); // the first cancellation's, and no other
    expect(after.bells).toBe(0);
  });

  it('a failing fan-out keeps the cancellation and leaves no half-change', async () => {
    const appt = await appointment(17);
    const wanted = await entry(17);
    faults.failWaitlistNotification = true;
    const res = await updateAppointmentAction(appt, { status: 'cancelled' });
    expect(res).toMatchObject({ ok: true });
    expect(await effects(wanted, appt)).toEqual({
      status: 'pending',
      notified: false,
      audits: [],
      bells: 0,
      appt: 'cancelled',
    });
    // The cancellation's own audit row and bell committed with it.
    expect(
      await unsafePrismaAdmin.auditLog.count({
        where: { organizationId: fx.org, entity: 'appointment', entityId: appt },
      }),
    ).toBe(1);
    expect(
      await unsafePrismaAdmin.notification.count({
        where: { organizationId: fx.org, type: 'booking' },
      }),
    ).toBe(1);
  });

  it('a status change that is not a cancellation leaves the waitlist alone', async () => {
    const appt = await appointment(20);
    const wanted = await entry(20);
    const res = await updateAppointmentAction(appt, { status: 'completed' });
    expect(res).toMatchObject({ ok: true });
    expect(await effects(wanted, appt)).toMatchObject({
      status: 'pending',
      audits: [],
      bells: 0,
      appt: 'completed',
    });
  });
});
