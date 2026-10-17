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

// An unexpected failure, injectable, carrying text that must never reach a user.
const { faults } = vi.hoisted(() => ({ faults: { tick: false, notify: false } }));
const SECRET = 'connection to db.internal:5432 failed (password=hunter2)';
vi.mock('@/lib/messaging/reminders', async () => {
  const actual = await vi.importActual<typeof import('@/lib/messaging/reminders')>(
    '@/lib/messaging/reminders',
  );
  return {
    ...actual,
    runReminderTick: (...args: Parameters<typeof actual.runReminderTick>) =>
      faults.tick ? Promise.reject(new Error(SECRET)) : actual.runReminderTick(...args),
  };
});
vi.mock('@/lib/notifications', async () => {
  const actual = await vi.importActual<typeof import('@/lib/notifications')>('@/lib/notifications');
  return {
    ...actual,
    notifyEvent: (...args: Parameters<typeof actual.notifyEvent>) =>
      faults.notify ? Promise.reject(new Error(SECRET)) : actual.notifyEvent(...args),
  };
});

const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { GENERIC_ERROR_MESSAGE } = await import('@/lib/action-result');
const { safeAction } = await import('@/lib/safe-action');
const { redirect, notFound } = await import('next/navigation');
const reminders = await import('@/components/reminders/actions');
const scheduler = await import('@/components/scheduler/actions');
const { fetchRescheduleSlotsAction } = await import('@/components/scheduler/reschedule-actions');
const billing = await import('@/components/billing/actions');

// -----------------------------------------------------------------------------
// Backlog F — a refused Server Action call comes back as a typed result.
//
// The production C7 UAT (2026-10-01) found that crafted calls without the
// permission were refused — nothing changed — but surfaced as an HTTP 500 with
// a minified digest: the refusal was THROWN out of the action, and a thrown
// error is what the framework masks. These actions now return a typed result
// for every expected outcome and the generic message for anything unexpected.
//
// Every refusal below also asserts that nothing changed. A typed result that
// came with a side effect would be worse than the crash it replaced.
// -----------------------------------------------------------------------------

type Who = 'owner' | 'provider' | 'colleague' | 'accountant' | 'fdA';
type Fx = {
  orgId: string;
  users: Record<Who, string>;
  locA: string;
  locB: string;
  staffMine: string; // provider's, at A
  staffColleague: string; // colleague's, at A
  staffB: string; // at B
  service: string;
  customer: string;
  apptMine: string;
  apptColleague: string;
};
let fx: Fx;
const ts = Date.now();
const createdUsers: string[] = [];

async function as(who: Who | null) {
  __clearAuthContextCache();
  authMock.mockReset();
  authMock.mockResolvedValue(who ? await mockJwt(fx.users[who], fx.orgId) : null);
}
function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const orgRow = () =>
  unsafePrismaAdmin.organization.findUniqueOrThrow({
    where: { id: fx.orgId },
    select: { reminderLeadHours: true, customerRetentionYears: true },
  });
const apptRow = (id: string) => unsafePrismaAdmin.appointment.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  fx = await withoutRls(async (tx) => {
    const role = async (key: string) =>
      (
        await tx.role.findFirstOrThrow({
          where: { key, organizationId: null },
          select: { id: true },
        })
      ).id;
    const org = await tx.organization.create({ data: { name: `TD Org ${ts}` } });
    const locA = await tx.location.create({
      data: { organizationId: org.id, type: 'clinic', name: 'TD A' },
    });
    const locB = await tx.location.create({
      data: { organizationId: org.id, type: 'clinic', name: 'TD B' },
    });
    const branchA = await tx.branch.findFirstOrThrow({ where: { legacyLocationId: locA.id } });
    const users = {} as Record<Who, string>;
    const add = async (
      who: Who,
      legacy: 'owner' | 'practitioner' | 'receptionist',
      roleKey: string,
    ) => {
      const u = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `td-${who}-${ts}@bookpitch.dev`,
          email: `td-${who}-${ts}@bookpitch.dev`,
        },
        select: { id: true },
      });
      createdUsers.push(u.id);
      users[who] = u.id;
      return tx.membership.create({
        data: { organizationId: org.id, userId: u.id, role: legacy, roleId: await role(roleKey) },
        select: { id: true },
      });
    };
    await add('owner', 'owner', 'ORG_OWNER');
    await add('provider', 'practitioner', 'PROVIDER');
    await add('colleague', 'practitioner', 'PROVIDER');
    await add('accountant', 'receptionist', 'ACCOUNTANT');
    const fdA = await add('fdA', 'receptionist', 'FRONT_DESK');
    await tx.membershipBranch.create({ data: { membershipId: fdA.id, branchId: branchA.id } });
    await tx.organization.update({ where: { id: org.id }, data: { ownerUserId: users.owner } });

    const staff = (locationId: string, name: string, userId?: string) =>
      tx.staff.create({
        data: { organizationId: org.id, locationId, name, roleTitle: 'GP', userId },
        select: { id: true },
      });
    const staffMine = (await staff(locA.id, 'TD mine', users.provider)).id;
    const staffColleague = (await staff(locA.id, 'TD colleague', users.colleague)).id;
    const staffB = (await staff(locB.id, 'TD at B')).id;
    const service = await tx.service.create({
      data: {
        organizationId: org.id,
        locationId: locA.id,
        name: 'TD svc',
        price: 10,
        durationMinutes: 30,
      },
    });
    const customer = await tx.customer.create({
      data: { organizationId: org.id, name: 'TD C', email: `td-c-${ts}@example.invalid` },
    });
    const appt = (staffId: string, hour: number) =>
      tx.appointment.create({
        data: {
          organizationId: org.id,
          locationId: locA.id,
          customerId: customer.id,
          staffId,
          serviceId: service.id,
          startsAt: new Date(Date.UTC(2031, 7, 5, hour)),
          endsAt: new Date(Date.UTC(2031, 7, 5, hour, 30)),
          serviceName: 'TD svc',
          price: 10,
        },
        select: { id: true },
      });
    return {
      orgId: org.id,
      users,
      locA: locA.id,
      locB: locB.id,
      staffMine,
      staffColleague,
      staffB,
      service: service.id,
      customer: customer.id,
      apptMine: (await appt(staffMine, 8)).id,
      apptColleague: (await appt(staffColleague, 9)).id,
    };
  });
});

afterAll(async () => {
  if (!fx) return;
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs([fx.orgId]);
  await withoutRls(async (tx) => {
    await tx.messageLog.deleteMany({ where: { organizationId: fx.orgId } });
    await tx.payment.deleteMany({ where: { organizationId: fx.orgId } });
    await tx.notification.deleteMany({ where: { organizationId: fx.orgId } });
    await tx.appointment.deleteMany({ where: { organizationId: fx.orgId } });
    await tx.service.deleteMany({ where: { organizationId: fx.orgId } });
    await tx.customer.deleteMany({ where: { organizationId: fx.orgId } });
    await tx.staff.deleteMany({ where: { organizationId: fx.orgId } });
    await tx.membershipBranch.deleteMany({ where: { membership: { organizationId: fx.orgId } } });
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
  faults.tick = false;
  faults.notify = false;
});

// -----------------------------------------------------------------------------
describe('safeAction lets the framework’s own control flow through', () => {
  it('redirect() still redirects — it is not reported as an internal failure', async () => {
    await expect(
      safeAction('t.redirect', async () => redirect('/elsewhere')),
    ).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT/) });
  });

  it('notFound() still reaches the not-found boundary', async () => {
    await expect(safeAction('t.notFound', async () => notFound())).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });
  });
});

// -----------------------------------------------------------------------------
describe('reminders actions', () => {
  it('unauthenticated → typed refusal, nothing changed', async () => {
    await as(null);
    const before = await orgRow();
    expect(await reminders.saveLeadHoursAction(fd({ hours: '12' }))).toMatchObject({
      ok: false,
      code: 'unauthenticated',
    });
    expect(await orgRow()).toEqual(before);
  });

  it('without the permission → typed refusal, nothing changed', async () => {
    await as('accountant'); // holds no booking.update and no org.settings.update
    const before = await orgRow();
    for (const call of [
      () => reminders.saveLeadHoursAction(fd({ hours: '12' })),
      () => reminders.saveTemplateAction(fd({ channel: 'sms', body: 'x' })),
      () => reminders.saveRetentionYearsAction(fd({ years: '2' })),
      () => reminders.runTickAction(),
      () => reminders.runRetentionTickAction(),
    ]) {
      expect(await call()).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(await orgRow()).toEqual(before);
    expect(
      await unsafePrismaAdmin.messageTemplate.count({ where: { organizationId: fx.orgId } }),
    ).toBe(0);
  });

  it('send-now on a colleague’s appointment → forbidden, and no message is sent', async () => {
    await as('provider');
    expect(await reminders.sendNowAction(fd({ appointmentId: fx.apptColleague }))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(
      await unsafePrismaAdmin.messageLog.count({ where: { appointmentId: fx.apptColleague } }),
    ).toBe(0);
  });

  it('send-now on an appointment that does not exist → typed refusal, nothing sent', async () => {
    await as('owner');
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(await reminders.sendNowAction(fd({ appointmentId: missing }))).toMatchObject({
      ok: false,
      code: 'invalid_input',
      message: 'appointment not found',
    });
    expect(await unsafePrismaAdmin.messageLog.count({ where: { appointmentId: missing } })).toBe(0);
  });

  it('invalid input → the domain message, nothing changed', async () => {
    await as('owner');
    const before = await orgRow();
    const r = await reminders.saveRetentionYearsAction(fd({ years: '99' }));
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(!r.ok && r.message).toMatch(/between 1 and 30/);
    expect(await orgRow()).toEqual(before);
  });

  it('an unexpected failure is an error — generic, and leaks nothing', async () => {
    await as('owner');
    faults.tick = true;
    const r = await reminders.runTickAction();
    expect(r).toEqual({ ok: false, code: 'internal', message: GENERIC_ERROR_MESSAGE });
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });

  it('and the allowed call still succeeds (the wrapper is not simply refusing)', async () => {
    await as('owner');
    expect(await reminders.saveRetentionYearsAction(fd({ years: '8' }))).toEqual({
      ok: true,
      data: undefined,
    });
    expect((await orgRow()).customerRetentionYears).toBe(8);
  });
});

// -----------------------------------------------------------------------------
describe('scheduler actions', () => {
  const booking = () => ({
    locationId: fx.locA,
    customerId: fx.customer,
    staffId: fx.staffMine,
    serviceId: fx.service,
    startsAt: new Date(Date.UTC(2031, 7, 6, 10)).toISOString(),
  });
  const apptCount = () =>
    unsafePrismaAdmin.appointment.count({ where: { organizationId: fx.orgId } });

  it('book, unauthenticated → typed refusal, nothing booked', async () => {
    await as(null);
    const before = await apptCount();
    expect(await scheduler.bookAppointmentAction(booking())).toMatchObject({
      ok: false,
      code: 'unauthenticated',
    });
    expect(await apptCount()).toBe(before);
  });

  it('book, without booking.create → typed refusal, nothing booked', async () => {
    await as('accountant');
    const before = await apptCount();
    const r = await scheduler.bookAppointmentAction(booking());
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    expect(!r.ok && r.error).toBeTruthy();
    expect(await apptCount()).toBe(before);
  });

  it('book, invalid input → the domain message, as before', async () => {
    await as('owner');
    expect(await scheduler.bookAppointmentAction({ ...booking(), staffId: 'nope' })).toEqual({
      ok: false,
      error: 'staffId must be a uuid',
    });
  });

  it('book, unexpected failure → generic, and the booking is rolled back', async () => {
    await as('owner');
    faults.notify = true;
    const before = await apptCount();
    expect(await scheduler.bookAppointmentAction(booking())).toEqual({
      ok: false,
      error: GENERIC_ERROR_MESSAGE,
      code: 'internal',
    });
    expect(await apptCount()).toBe(before);
  });

  it('update a colleague’s appointment → forbidden, unchanged', async () => {
    await as('provider');
    const before = await apptRow(fx.apptColleague);
    expect(
      await scheduler.updateAppointmentAction(fx.apptColleague, { status: 'confirmed' }),
    ).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await apptRow(fx.apptColleague)).toEqual(before);
  });

  it('update an appointment that does not exist → the established "no longer exists" result', async () => {
    await as('owner');
    expect(
      await scheduler.updateAppointmentAction('00000000-0000-4000-8000-000000000000', {
        status: 'confirmed',
      }),
    ).toEqual({ ok: true, appointment: null });
  });

  it('update one’s own appointment still works', async () => {
    await as('provider');
    const r = await scheduler.updateAppointmentAction(fx.apptMine, { notes: 'mine' });
    expect(r.ok).toBe(true);
    expect((await apptRow(fx.apptMine)).notes).toBe('mine');
  });

  it('slot lookup: unauthenticated / no booking.read / out of branch → typed refusals', async () => {
    await as(null);
    expect(await scheduler.fetchAvailableSlotsAction(fx.staffMine, '2031-08-06', 30)).toMatchObject(
      { ok: false, code: 'unauthenticated' },
    );
    await as('accountant');
    expect(await scheduler.fetchAvailableSlotsAction(fx.staffMine, '2031-08-06', 30)).toMatchObject(
      { ok: false, code: 'forbidden' },
    );
    await as('fdA'); // branch A only; staffB works at B
    expect(await scheduler.fetchAvailableSlotsAction(fx.staffB, '2031-08-06', 30)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('slot lookup, allowed → the slots', async () => {
    await as('fdA');
    const r = await scheduler.fetchAvailableSlotsAction(fx.staffMine, '2031-08-06', 30);
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.length).toBeGreaterThan(0);
  });

  it('reschedule lookup: unauthenticated / a colleague’s appointment → typed codes', async () => {
    await as(null);
    expect(await fetchRescheduleSlotsAction(fx.apptMine, fx.staffMine, '2031-08-06')).toEqual({
      ok: false,
      error: 'unauthenticated',
    });
    await as('provider');
    expect(
      await fetchRescheduleSlotsAction(fx.apptColleague, fx.staffColleague, '2031-08-06'),
    ).toEqual({ ok: false, error: 'forbidden' });
  });

  it('reschedule lookup keeps its existing codes for a missing appointment and bad input', async () => {
    await as('owner');
    expect(
      await fetchRescheduleSlotsAction(
        '00000000-0000-4000-8000-000000000000',
        fx.staffMine,
        '2031-08-06',
      ),
    ).toEqual({ ok: false, error: 'appointment_not_found' });
    expect(await fetchRescheduleSlotsAction('nope', fx.staffMine, '2031-08-06')).toEqual({
      ok: false,
      error: 'invalid_request',
    });
  });
});

// -----------------------------------------------------------------------------
describe('billing actions', () => {
  const payments = () => unsafePrismaAdmin.payment.count({ where: { organizationId: fx.orgId } });

  it('cash, unauthenticated / without payment.charge → typed refusals, nothing paid', async () => {
    const before = await payments();
    await as(null);
    expect(await billing.settleCashAction(fd({ appointmentId: fx.apptMine }))).toMatchObject({
      ok: false,
      code: 'unauthenticated',
    });
    await as('accountant');
    expect(await billing.settleCashAction(fd({ appointmentId: fx.apptMine }))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(await payments()).toBe(before);
    expect((await apptRow(fx.apptMine)).paymentStatus).toBe('unpaid');
  });

  it('card checkout without payment.charge → typed refusal, no redirect', async () => {
    await as('accountant');
    expect(await billing.startCardCheckoutAction(fd({ appointmentId: fx.apptMine }))).toMatchObject(
      { ok: false, code: 'forbidden' },
    );
  });

  it('card checkout, allowed → still REDIRECTS to the gateway', async () => {
    await as('owner');
    await expect(
      billing.startCardCheckoutAction(fd({ appointmentId: fx.apptMine })),
    ).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT/) });
  });

  it('cash, allowed → paid', async () => {
    await as('owner');
    expect(await billing.settleCashAction(fd({ appointmentId: fx.apptColleague }))).toEqual({
      ok: true,
      data: undefined,
    });
    expect((await apptRow(fx.apptColleague)).paymentStatus).toBe('paid');
  });
});
