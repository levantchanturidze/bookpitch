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

const sent: string[] = [];
vi.mock('@/lib/messaging', () => ({
  getSmsProvider: () => ({
    name: 'scope-sms',
    send: async (to: string) => {
      sent.push(`sms:${to}`);
      return { providerMsgId: `scope_sms_${sent.length}` };
    },
  }),
  getEmailProvider: () => ({
    name: 'scope-email',
    send: async (to: string) => {
      sent.push(`email:${to}`);
      return { providerMsgId: `scope_email_${sent.length}` };
    },
  }),
}));

// RLS is what normally hides another organisation's rows from withOrg. Here it
// is taken away: withOrg runs on the RLS-bypassing client. That is the failure
// the explicit filter exists for (CLAUDE.md invariant 1: a query without
// organization_id is a bug "regardless of what the surrounding code appears to
// guarantee"), and the only condition under which the filter is observable.
vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  return {
    ...actual,
    withOrg: (<T>(_orgId: string, fn: Parameters<typeof actual.withoutRls<T>>[0]) =>
      actual.withoutRls(fn)) as typeof actual.withOrg,
  };
});

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const { sendNowForSession } = await import('@/lib/messaging/reminders');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { requireAuthContext } = await import('@/lib/rbac');
const { ctxToSession } = await import('@/lib/auth');

// -----------------------------------------------------------------------------
// "Send now" checks that the appointment belongs to the caller's organisation,
// then hands it to sendForAppointment, which runs WITHOUT RLS. The check used
// to be `findUnique({ where: { id } })` inside withOrg, so RLS was the only
// barrier between a session and another organisation's customer.
// -----------------------------------------------------------------------------
describe('send-now names the organisation in the check that guards an RLS-bypassing send', () => {
  const stamp = Date.now();
  const fx = { orgA: '', orgB: '', ownerA: '', ownerB: '', apptB: '' };

  async function sessionOf(userId: string, orgId: string) {
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockJwt(userId, orgId));
    return ctxToSession(await requireAuthContext());
  }
  const logsFor = (appointmentId: string) =>
    unsafePrismaAdmin.messageLog.count({ where: { appointmentId } });

  beforeAll(async () => {
    const seeded = await withoutRls(async (tx) => {
      const ownerRole = await tx.role.findFirstOrThrow({
        where: { key: 'ORG_OWNER', organizationId: null },
        select: { id: true },
      });
      const out: Record<string, string> = {};
      for (const tag of ['A', 'B']) {
        // Archived: a live ownerless organisation breaks the ownership invariant.
        const org = await tx.organization.create({
          data: { name: `send-now-scope-${tag}-${stamp}`, status: 'archived' },
          select: { id: true },
        });
        const user = await tx.appUser.create({
          data: {
            authProvider: 'credentials',
            authSubject: `send-now-${tag}-${stamp}@bp.test`,
            email: `send-now-${tag}-${stamp}@bp.test`,
          },
          select: { id: true },
        });
        await tx.membership.create({
          data: { organizationId: org.id, userId: user.id, role: 'owner', roleId: ownerRole.id },
        });
        out[`org${tag}`] = org.id;
        out[`owner${tag}`] = user.id;
      }
      const loc = await tx.location.create({
        data: { organizationId: out.orgB, name: 'B', type: 'clinic', timezone: 'UTC' },
        select: { id: true },
      });
      const staff = await tx.staff.create({
        data: { organizationId: out.orgB, locationId: loc.id, name: 'B Dr', roleTitle: 'GP' },
        select: { id: true },
      });
      const customer = await tx.customer.create({
        data: {
          organizationId: out.orgB,
          name: 'B Customer',
          email: `b-customer-${stamp}@bp.test`,
          phone: '+995500000121',
        },
        select: { id: true },
      });
      const startsAt = new Date(Date.now() + 3 * 24 * 3_600_000);
      const appt = await tx.appointment.create({
        data: {
          organizationId: out.orgB,
          locationId: loc.id,
          customerId: customer.id,
          staffId: staff.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          serviceName: 'Scope check',
          price: 10,
          status: 'confirmed',
        },
        select: { id: true },
      });
      return { ...out, apptB: appt.id };
    });
    Object.assign(fx, seeded);
  });

  // Each test starts with no reminder recorded, so neither depends on the
  // other's side effects (a send leaked by the first would dedupe the second).
  beforeEach(async () => {
    sent.length = 0;
    await withoutRls((tx) => tx.messageLog.deleteMany({ where: { appointmentId: fx.apptB } }));
  });

  afterAll(async () => {
    const orgs = [fx.orgA, fx.orgB];
    await withoutRls(async (tx) => {
      await tx.messageLog.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.notification.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.appointment.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.customer.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.staff.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.location.deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.membership.deleteMany({ where: { organizationId: { in: orgs } } });
    });
    const { resetAuditForOrgs } = await import('./helpers/audit-reset');
    await resetAuditForOrgs(orgs);
    await withoutRls(async (tx) => {
      await tx.appUser.deleteMany({ where: { id: { in: [fx.ownerA, fx.ownerB] } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
    });
  });

  it("refuses another organisation's appointment even when RLS does not filter", async () => {
    const sessionA = await sessionOf(fx.ownerA, fx.orgA);
    await expect(sendNowForSession(sessionA, fx.apptB)).rejects.toThrow(/appointment not found/);
    expect(sent).toEqual([]);
    expect(await logsFor(fx.apptB)).toBe(0);
  });

  it('COMPLEMENT: the owning organisation sends, so the refusal above is not vacuous', async () => {
    const sessionB = await sessionOf(fx.ownerB, fx.orgB);
    const reports = await sendNowForSession(sessionB, fx.apptB);
    expect(reports.length).toBeGreaterThan(0);
    expect(sent.length).toBeGreaterThan(0);
    expect(await logsFor(fx.apptB)).toBeGreaterThan(0);
  });
});
