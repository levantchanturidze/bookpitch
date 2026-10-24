import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const { authMock, provider } = vi.hoisted(() => ({
  authMock: vi.fn(),
  provider: {
    sent: [] as Array<{ to: string; body: string }>,
    // Runs inside send(): the provider has the message, no transaction is open.
    during: null as null | (() => Promise<void>),
  },
}));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/messaging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/messaging')>()),
  getSmsProvider: () => ({
    name: 'test-sms',
    send: async () => {
      throw new Error('SMS is not under test');
    },
  }),
  getEmailProvider: () => ({
    name: 'test-email',
    send: async (to: string, _subject: string, body: string) => {
      provider.sent.push({ to, body });
      const during = provider.during;
      provider.during = null;
      if (during) await during();
      return { providerMsgId: `race_${provider.sent.length}` };
    },
  }),
}));

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const { sendForAppointment } = await import('@/lib/messaging/reminders');
const { anonymizeCustomer, CUSTOMER_REDACTION_FIELDS, REDACTED_MESSAGE_FIELD } =
  await import('@/lib/gdpr');
const { lockCustomerWaitlist } = await import('@/lib/waitlist');
const { RateLimit } = await import('@/lib/rate-limit');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { requireAuthContext } = await import('@/lib/rbac');
const { ctxToSession } = await import('@/lib/auth');

// -----------------------------------------------------------------------------
// A reminder is rendered (prepare) before it is claimed and sent. An erasure
// that commits in between used to change nothing for it: the claim wrote the
// rendered address and name into a new delivery record, the provider was sent
// them, and the "Reminder sent" notification copied the name. All of it after
// the erasure had committed, so after it had cleared every record it could find.
//
// RateLimit.messaging() runs exactly between prepare() and claim(), and the
// provider's send() runs with no transaction open, so the erasure is committed
// at those two points through them. The third case holds an erasure's own lock
// open while a reminder reads the customer.
// -----------------------------------------------------------------------------
const stamp = Date.now();
const fx = { org: '', owner: '', loc: '', staff: '' };
let session: ReturnType<typeof ctxToSession>;
const limiter = vi.spyOn(RateLimit, 'messaging');
let slot = 0;

async function bookedCustomer(label: string, email: string | null) {
  const startsAt = new Date(Date.UTC(2031, 0, 6, 8) + slot++ * 3_600_000);
  return withoutRls(async (tx) => {
    const customer = await tx.customer.create({
      data: { organizationId: fx.org, name: `${label} ${stamp}`, email },
      select: { id: true, name: true },
    });
    const appt = await tx.appointment.create({
      data: {
        organizationId: fx.org,
        locationId: fx.loc,
        customerId: customer.id,
        staffId: fx.staff,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        serviceName: 'Race check',
        price: 10,
        status: 'confirmed',
      },
      select: { id: true },
    });
    return { customer: customer.id, name: customer.name, appt: appt.id };
  });
}
const recordsOf = (appointmentId: string) =>
  unsafePrismaAdmin.messageLog.findMany({
    where: { organizationId: fx.org, appointmentId },
    select: { state: true, toAddress: true, body: true },
  });
const notificationsJson = async () =>
  JSON.stringify(
    await unsafePrismaAdmin.notification.findMany({
      where: { organizationId: fx.org },
      select: { title: true, body: true },
    }),
  );

beforeAll(async () => {
  const seeded = await withoutRls(async (tx) => {
    const role = await tx.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
      select: { id: true },
    });
    // Archived: a live ownerless organisation breaks the ownership invariant.
    const org = await tx.organization.create({
      data: { name: `erasure-race-${stamp}`, status: 'archived' },
      select: { id: true },
    });
    const owner = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: `erasure-race-${stamp}@bp.test`,
        email: `erasure-race-${stamp}@bp.test`,
      },
      select: { id: true },
    });
    await tx.membership.create({
      data: { organizationId: org.id, userId: owner.id, role: 'owner', roleId: role.id },
    });
    const loc = await tx.location.create({
      data: { organizationId: org.id, name: 'R', type: 'clinic', timezone: 'UTC' },
      select: { id: true },
    });
    const staff = await tx.staff.create({
      data: { organizationId: org.id, locationId: loc.id, name: 'R Dr', roleTitle: 'GP' },
      select: { id: true },
    });
    return { org: org.id, owner: owner.id, loc: loc.id, staff: staff.id };
  });
  Object.assign(fx, seeded);
  __clearAuthContextCache();
  authMock.mockResolvedValue(await mockJwt(fx.owner, fx.org));
  session = ctxToSession(await requireAuthContext());
});

beforeEach(() => {
  provider.sent.length = 0;
  provider.during = null;
  limiter.mockReset();
  limiter.mockResolvedValue({ count: 1, limit: 60 });
});

afterAll(async () => {
  limiter.mockRestore();
  await withoutRls(async (tx) => {
    await tx.messageLog.deleteMany({ where: { organizationId: fx.org } });
    await tx.notification.deleteMany({ where: { organizationId: fx.org } });
    await tx.appointment.deleteMany({ where: { organizationId: fx.org } });
    await tx.customer.deleteMany({ where: { organizationId: fx.org } });
    await tx.staff.deleteMany({ where: { organizationId: fx.org } });
    await tx.location.deleteMany({ where: { organizationId: fx.org } });
    await tx.membership.deleteMany({ where: { organizationId: fx.org } });
  });
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs([fx.org]);
  await withoutRls(async (tx) => {
    await tx.appUser.deleteMany({ where: { id: fx.owner } });
    await tx.organization.deleteMany({ where: { id: fx.org } });
  });
});

describe('a reminder prepared before an erasure is not sent after it', () => {
  it('COMPLEMENT: with nothing changing in between, the reminder is sent', async () => {
    const email = `baseline-${stamp}@bp.test`;
    const c = await bookedCustomer('Baseline Customer', email);
    expect((await sendForAppointment(c.appt, 'email')).outcome).toBe('sent');
    expect(provider.sent.map((s) => s.to)).toEqual([email]);
    expect(provider.sent[0].body).toContain(c.name);
  });

  it('an erasure between prepare and claim: nothing is sent, nothing records the person', async () => {
    const email = `erased-midway-${stamp}@bp.test`;
    const c = await bookedCustomer('Erased Midway', email);
    limiter.mockImplementationOnce(async () => {
      await anonymizeCustomer(session, c.customer, 'gdpr');
      return { count: 1, limit: 60 };
    });

    const report = await sendForAppointment(c.appt, 'email');

    expect(report.outcome).toBe('skipped_missing_contact');
    expect(provider.sent).toEqual([]);
    const records = JSON.stringify(await recordsOf(c.appt));
    expect(records).not.toContain(email);
    expect(records).not.toContain(c.name);
    expect(await notificationsJson()).not.toContain(c.name);
  });

  it('an edit between prepare and claim: the reminder goes to the address there now', async () => {
    const c = await bookedCustomer('Edited Midway', `old-${stamp}@bp.test`);
    limiter.mockImplementationOnce(async () => {
      await withoutRls((tx) =>
        tx.customer.updateMany({
          where: { id: c.customer, organizationId: fx.org },
          data: { email: `new-${stamp}@bp.test` },
        }),
      );
      return { count: 1, limit: 60 };
    });

    expect((await sendForAppointment(c.appt, 'email')).outcome).toBe('sent');
    expect(provider.sent.map((s) => s.to)).toEqual([`new-${stamp}@bp.test`]);
    // Prepared twice, charged once.
    expect(limiter).toHaveBeenCalledTimes(1);
  });
});

describe('an erasure while the provider call is in flight', () => {
  it('cannot recall the send, but the record stays cleared and the notification has no name', async () => {
    const email = `in-flight-${stamp}@bp.test`;
    const c = await bookedCustomer('Erased In Flight', email);
    provider.during = () => anonymizeCustomer(session, c.customer, 'gdpr');

    // The provider had the message before the erasure began. The claim that
    // authorised the send committed first, and nothing can unsend it.
    expect((await sendForAppointment(c.appt, 'email')).outcome).toBe('sent');
    expect(provider.sent.map((s) => s.to)).toEqual([email]);

    // The settle wrote the state, and nothing back into what the erasure cleared.
    expect(await recordsOf(c.appt)).toEqual([
      { state: 'sent', toAddress: REDACTED_MESSAGE_FIELD, body: REDACTED_MESSAGE_FIELD },
    ]);
    const [sentNote] = await unsafePrismaAdmin.notification.findMany({
      where: { organizationId: fx.org, title: 'Reminder sent (email)' },
      select: { body: true },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(sentNote.body).toMatch(/^Redacted Customer #/);
    expect(await notificationsJson()).not.toContain(c.name);
  });
});

describe('the missing-contact record is written under the customer lock', () => {
  it('a reminder that reads the customer mid-erasure waits, and records what the erasure left', async () => {
    // No email address: prepare() records why nothing went out, with the body.
    const c = await bookedCustomer('No Address', null);
    let held!: () => void;
    const lockHeld = new Promise<void>((resolve) => (held = resolve));
    // An erasure's own first step, then its writes, then held open uncommitted.
    const erasure = withoutRls(async (tx) => {
      await lockCustomerWaitlist(tx, fx.org, c.customer);
      await tx.messageLog.updateMany({
        where: { organizationId: fx.org, appointment: { is: { customerId: c.customer } } },
        data: { toAddress: REDACTED_MESSAGE_FIELD, body: REDACTED_MESSAGE_FIELD },
      });
      await tx.customer.updateMany({
        where: { id: c.customer, organizationId: fx.org },
        data: {
          name: `Redacted Customer #${c.customer.slice(0, 8)}`,
          ...CUSTOMER_REDACTION_FIELDS,
        },
      });
      held();
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await lockHeld;

    const report = await sendForAppointment(c.appt, 'email');
    await erasure;

    expect(report.outcome).toBe('skipped_missing_contact');
    const records = await recordsOf(c.appt);
    expect(records).toHaveLength(1);
    expect(records[0].body).not.toContain(c.name);
    expect(records[0].body).toContain('Redacted Customer #');
  });
});
