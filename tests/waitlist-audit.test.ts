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

// Two failure switches, so the failure POLICY can be observed rather than
// assumed. Each wraps the real implementation and is off unless a test arms it.
const { faults } = vi.hoisted(() => ({
  faults: { failWaitlistAudit: false, failNotificationSql: false },
}));
vi.mock('@/lib/audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit')>('@/lib/audit');
  return {
    ...actual,
    writeAudit: (...args: Parameters<typeof actual.writeAudit>) => {
      if (faults.failWaitlistAudit && args[3] === 'waitlist') {
        return Promise.reject(new Error('injected: audit store unavailable'));
      }
      return actual.writeAudit(...args);
    },
  };
});
vi.mock('@/lib/notifications', async () => {
  const actual = await vi.importActual<typeof import('@/lib/notifications')>('@/lib/notifications');
  return {
    ...actual,
    // A real failing STATEMENT, not a thrown JS error: that is what aborts a
    // PostgreSQL transaction, and what the bare catch {} in the PATCH route
    // used to turn into a silent rollback of the whole cancellation.
    notifyEvent: async (...args: Parameters<typeof actual.notifyEvent>) => {
      if (faults.failNotificationSql) {
        await args[0].$executeRawUnsafe('SELECT * FROM injected_missing_table_for_waitlist_test');
      }
      return actual.notifyEvent(...args);
    },
  };
});

const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const waitlistRoute = await import('@/app/api/waitlist/route');
const waitlistEntryRoute = await import('@/app/api/waitlist/[id]/route');
const appointmentRoute = await import('@/app/api/appointments/[id]/route');

import type { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// Backlog C — the waitlist audit trail.
//
// Adding a customer to the waitlist, removing them, and marking their entry
// `notified` when a matching slot opens were all unaudited (no `waitlist`
// entity existed). Each now writes an audit row in the SAME transaction as the
// change. These tests read the audit table itself — the artefact an auditor
// reads — never the arguments to writeAudit.
// -----------------------------------------------------------------------------

type Who = 'owner' | 'provider' | 'fdA' | 'accountant' | 'otherOwner';
type Fx = {
  orgId: string;
  otherOrgId: string;
  users: Record<Who, string>;
  locA: string;
  locB: string;
  staffA: string; // linked to `provider`
  staffB: string;
  svcA: string;
  customer: string;
  otherCustomer: string;
};
let fx: Fx;
const ts = Date.now();
const createdUsers: string[] = [];
const WINDOW = {
  preferredFrom: '2031-05-01T00:00:00.000Z',
  preferredTo: '2031-05-31T00:00:00.000Z',
};

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}
async function as(who: Who) {
  authMock.mockResolvedValue(
    await mockJwt(fx.users[who], who === 'otherOwner' ? fx.otherOrgId : fx.orgId),
  );
}
async function waitlistAudits(orgId = fx.orgId) {
  return unsafePrismaAdmin.auditLog.findMany({
    where: { organizationId: orgId, entity: 'waitlist' },
    orderBy: { id: 'asc' },
    select: { action: true, entity: true, entityId: true, actorUserId: true, meta: true },
  });
}
async function post(body: Record<string, unknown>) {
  return waitlistRoute.POST(
    req('http://x/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
async function del(id: string) {
  return waitlistEntryRoute.DELETE(req(`http://x/api/waitlist/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });
}
/** A waitlist row created directly (no audit), for the tests that act on one. */
async function seedEntry(
  data: Partial<{ locationId: string; staffId: string; serviceId: string; orgId: string }> = {},
) {
  const orgId = data.orgId ?? fx.orgId;
  return (
    await withoutRls((tx) =>
      tx.waitlist.create({
        data: {
          organizationId: orgId,
          customerId: orgId === fx.orgId ? fx.customer : fx.otherCustomer,
          locationId: data.locationId ?? null,
          staffId: data.staffId ?? null,
          serviceId: data.serviceId ?? null,
          preferredFrom: new Date(WINDOW.preferredFrom),
          preferredTo: new Date(WINDOW.preferredTo),
          notes: 'Prefers mornings; recovering from knee surgery',
        },
        select: { id: true },
      }),
    )
  ).id;
}

beforeAll(async () => {
  fx = await withoutRls(async (tx) => {
    const role = async (key: string) =>
      (
        await tx.role.findFirstOrThrow({
          where: { key, organizationId: null },
          select: { id: true },
        })
      ).id;
    const org = await tx.organization.create({ data: { name: `WLA Org ${ts}` } });
    const other = await tx.organization.create({ data: { name: `WLA Other ${ts}` } });
    const user = async (tag: string) => {
      const u = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `wla-${tag}-${ts}@bookpitch.dev`,
          email: `wla-${tag}-${ts}@bookpitch.dev`,
        },
        select: { id: true },
      });
      createdUsers.push(u.id);
      return u.id;
    };
    const users: Record<Who, string> = {
      owner: await user('owner'),
      provider: await user('provider'),
      fdA: await user('fd-a'),
      accountant: await user('accountant'),
      otherOwner: await user('other-owner'),
    };
    const member = async (
      orgId: string,
      userId: string,
      legacy: 'owner' | 'practitioner' | 'receptionist',
      roleKey: string,
    ) =>
      tx.membership.create({
        data: { organizationId: orgId, userId, role: legacy, roleId: await role(roleKey) },
        select: { id: true },
      });
    await member(org.id, users.owner, 'owner', 'ORG_OWNER');
    await member(org.id, users.provider, 'practitioner', 'PROVIDER');
    const fdMembership = await member(org.id, users.fdA, 'receptionist', 'FRONT_DESK');
    await member(org.id, users.accountant, 'receptionist', 'ACCOUNTANT');
    await member(other.id, users.otherOwner, 'owner', 'ORG_OWNER');
    await tx.organization.update({ where: { id: org.id }, data: { ownerUserId: users.owner } });
    await tx.organization.update({
      where: { id: other.id },
      data: { ownerUserId: users.otherOwner },
    });

    const locA = await tx.location.create({
      data: { organizationId: org.id, type: 'clinic', name: 'WLA A' },
    });
    const locB = await tx.location.create({
      data: { organizationId: org.id, type: 'clinic', name: 'WLA B' },
    });
    const branchA = await tx.branch.findFirstOrThrow({ where: { legacyLocationId: locA.id } });
    // FD-A reaches branch A only.
    await tx.membershipBranch.create({
      data: { membershipId: fdMembership.id, branchId: branchA.id },
    });
    const staffA = await tx.staff.create({
      data: {
        organizationId: org.id,
        locationId: locA.id,
        name: 'WLA A staff',
        roleTitle: 'GP',
        userId: users.provider,
      },
    });
    const staffB = await tx.staff.create({
      data: { organizationId: org.id, locationId: locB.id, name: 'WLA B staff', roleTitle: 'GP' },
    });
    const svcA = await tx.service.create({
      data: {
        organizationId: org.id,
        locationId: locA.id,
        name: 'WLA svc',
        price: 10,
        durationMinutes: 30,
      },
    });
    const customer = await tx.customer.create({
      data: { organizationId: org.id, name: 'WLA Customer' },
    });
    const otherCustomer = await tx.customer.create({
      data: { organizationId: other.id, name: 'WLA Foreign Customer' },
    });
    return {
      orgId: org.id,
      otherOrgId: other.id,
      users,
      locA: locA.id,
      locB: locB.id,
      staffA: staffA.id,
      staffB: staffB.id,
      svcA: svcA.id,
      customer: customer.id,
      otherCustomer: otherCustomer.id,
    };
  });
});

afterAll(async () => {
  if (!fx) return;
  const orgs = [fx.orgId, fx.otherOrgId];
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs(orgs);
  await withoutRls(async (tx) => {
    await tx.waitlist.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.notification.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.appointment.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.service.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.customer.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.staff.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.location.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.membership.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.organization.updateMany({ where: { id: { in: orgs } }, data: { ownerUserId: null } });
  });
  await withoutRls(async (tx) => {
    await tx.appUser.deleteMany({ where: { id: { in: createdUsers } } });
    await tx.organization.deleteMany({ where: { id: { in: orgs } } });
  });
});

beforeEach(async () => {
  authMock.mockReset();
  __clearAuthContextCache();
  faults.failWaitlistAudit = false;
  faults.failNotificationSql = false;
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs([fx.orgId, fx.otherOrgId]);
  await withoutRls(async (tx) => {
    await tx.waitlist.deleteMany({ where: { organizationId: { in: [fx.orgId, fx.otherOrgId] } } });
    await tx.notification.deleteMany({ where: { organizationId: fx.orgId } });
    await tx.appointment.deleteMany({ where: { organizationId: fx.orgId } });
  });
});

// -----------------------------------------------------------------------------
describe('every waitlist change leaves an audit row', () => {
  it('adding an entry is audited — identifiers only, never the free-text notes', async () => {
    await as('owner');
    const res = await post({
      customerId: fx.customer,
      staffId: fx.staffA,
      serviceId: fx.svcA,
      ...WINDOW,
      notes: 'Prefers mornings; recovering from knee surgery',
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(await waitlistAudits()).toEqual([
      {
        action: 'create',
        entity: 'waitlist',
        entityId: id,
        actorUserId: fx.users.owner,
        meta: { customerId: fx.customer, locationId: null, staffId: fx.staffA, serviceId: fx.svcA },
      },
    ]);
  });

  it('removing an entry is audited with what was removed', async () => {
    const id = await seedEntry({ locationId: fx.locA, staffId: fx.staffA });
    await as('owner');
    expect((await del(id)).status).toBe(200);
    expect(await unsafePrismaAdmin.waitlist.count({ where: { id } })).toBe(0);
    expect(await waitlistAudits()).toEqual([
      {
        action: 'delete',
        entity: 'waitlist',
        entityId: id,
        actorUserId: fx.users.owner,
        meta: {
          customerId: fx.customer,
          locationId: fx.locA,
          staffId: fx.staffA,
          serviceId: null,
          status: 'pending',
        },
      },
    ]);
  });

  it('a cancellation that opens a slot audits each entry it marks notified — and only those', async () => {
    const starts = new Date('2031-05-10T09:00:00Z');
    const appt = await withoutRls((tx) =>
      tx.appointment.create({
        data: {
          organizationId: fx.orgId,
          locationId: fx.locA,
          customerId: fx.customer,
          staffId: fx.staffA,
          serviceId: fx.svcA,
          startsAt: starts,
          endsAt: new Date(starts.getTime() + 30 * 60_000),
          serviceName: 'WLA svc',
          price: 10,
        },
        select: { id: true },
      }),
    );
    const matchesStaff = await seedEntry({ staffId: fx.staffA });
    const matchesAny = await seedEntry();
    const otherStaff = await seedEntry({ staffId: fx.staffB }); // does not match

    await as('owner');
    const res = await appointmentRoute.PATCH(
      req(`http://x/api/appointments/${appt.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      }),
      { params: Promise.resolve({ id: appt.id }) },
    );
    expect(res.status).toBe(200);

    const audits = await waitlistAudits();
    expect(audits.map((a) => a.entityId).sort()).toEqual([matchesStaff, matchesAny].sort());
    for (const a of audits) {
      expect(a).toMatchObject({
        action: 'update',
        entity: 'waitlist',
        actorUserId: fx.users.owner, // whoever cancelled
        meta: { status: 'notified', appointmentId: appt.id },
      });
    }
    const unmatched = await unsafePrismaAdmin.waitlist.findUniqueOrThrow({
      where: { id: otherStaff },
    });
    expect(unmatched.status).toBe('pending');
  });
});

// -----------------------------------------------------------------------------
describe('a refused change is not audited as if it had happened', () => {
  it('a front desk scoped to branch A cannot remove a branch-B entry (403, kept, unaudited)', async () => {
    const id = await seedEntry({ locationId: fx.locB });
    await as('fdA');
    expect((await del(id)).status).toBe(403);
    expect(await unsafePrismaAdmin.waitlist.count({ where: { id } })).toBe(1);
    expect(await waitlistAudits()).toEqual([]);

    // Its twin: a branch-A entry is theirs to remove, and that IS audited.
    const mine = await seedEntry({ locationId: fx.locA });
    expect((await del(mine)).status).toBe(200);
    expect((await waitlistAudits()).map((a) => [a.action, a.entityId])).toEqual([['delete', mine]]);
  });

  it('a provider cannot remove an entry that is not theirs (403, kept, unaudited)', async () => {
    const id = await seedEntry({ staffId: fx.staffB });
    await as('provider');
    expect((await del(id)).status).toBe(403);
    expect(await unsafePrismaAdmin.waitlist.count({ where: { id } })).toBe(1);
    expect(await waitlistAudits()).toEqual([]);
  });

  it('a role without booking.create cannot add one (403, nothing written)', async () => {
    await as('accountant');
    const res = await post({ customerId: fx.customer, ...WINDOW });
    expect(res.status).toBe(403);
    expect(await unsafePrismaAdmin.waitlist.count({ where: { organizationId: fx.orgId } })).toBe(0);
    expect(await waitlistAudits()).toEqual([]);
  });

  it('an unauthenticated add is 401 and writes nothing', async () => {
    authMock.mockResolvedValue(null);
    expect((await post({ customerId: fx.customer, ...WINDOW })).status).toBe(401);
    expect(await unsafePrismaAdmin.waitlist.count({ where: { organizationId: fx.orgId } })).toBe(0);
    expect(await waitlistAudits()).toEqual([]);
  });

  it("another organisation's customer is unknown here (400, nothing written)", async () => {
    await as('owner');
    const res = await post({ customerId: fx.otherCustomer, ...WINDOW });
    expect(res.status).toBe(400);
    expect(await unsafePrismaAdmin.waitlist.count({ where: { organizationId: fx.orgId } })).toBe(0);
    expect(await waitlistAudits()).toEqual([]);
  });

  it("another organisation's entry is not found (404), kept, and audited nowhere", async () => {
    const foreign = await seedEntry({ orgId: fx.otherOrgId });
    await as('owner');
    expect((await del(foreign)).status).toBe(404);
    expect(await unsafePrismaAdmin.waitlist.count({ where: { id: foreign } })).toBe(1);
    expect(await waitlistAudits()).toEqual([]);
    expect(await waitlistAudits(fx.otherOrgId)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Audit failures follow the application's existing policy: the audit row is
// written inline, in the change's own transaction, so a failed audit write
// fails the change rather than leaving an unaudited one behind.
// -----------------------------------------------------------------------------
describe('audit failure policy', () => {
  it('if the audit row cannot be written, the entry is not added either', async () => {
    faults.failWaitlistAudit = true;
    await as('owner');
    // withApi re-throws an unexpected error so the platform answers 500 with
    // the stack in its logs — a rejected handler IS the 500 path.
    await expect(post({ customerId: fx.customer, ...WINDOW })).rejects.toThrow(/injected/);
    expect(await unsafePrismaAdmin.waitlist.count({ where: { organizationId: fx.orgId } })).toBe(0);
  });

  it('if the audit row cannot be written, the entry is not removed either', async () => {
    const id = await seedEntry({ locationId: fx.locA });
    faults.failWaitlistAudit = true;
    await as('owner');
    await expect(del(id)).rejects.toThrow(/injected/);
    expect(await unsafePrismaAdmin.waitlist.count({ where: { id } })).toBe(1);
  });

  it('a failing waitlist fan-out does not undo the cancellation — and leaves no half-change', async () => {
    // The fan-out is best-effort by design. It used to sit in a bare `catch {}`
    // INSIDE the transaction, where a failed statement aborts everything: the
    // callback returned normally, COMMIT rolled the whole transaction back,
    // and the route answered 200 for a cancellation that never happened.
    const starts = new Date('2031-05-12T09:00:00Z');
    const appt = await withoutRls((tx) =>
      tx.appointment.create({
        data: {
          organizationId: fx.orgId,
          locationId: fx.locA,
          customerId: fx.customer,
          staffId: fx.staffA,
          startsAt: starts,
          endsAt: new Date(starts.getTime() + 30 * 60_000),
          serviceName: 'WLA svc',
          price: 10,
        },
        select: { id: true },
      }),
    );
    const entry = await seedEntry({ staffId: fx.staffA });
    faults.failNotificationSql = true;

    await as('owner');
    const res = await appointmentRoute.PATCH(
      req(`http://x/api/appointments/${appt.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      }),
      { params: Promise.resolve({ id: appt.id }) },
    );
    expect(res.status).toBe(200);

    // The cancellation — and its own audit row — committed.
    const row = await unsafePrismaAdmin.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(row.status).toBe('cancelled');
    expect(
      await unsafePrismaAdmin.auditLog.count({
        where: { organizationId: fx.orgId, entity: 'appointment', entityId: appt.id },
      }),
    ).toBe(1);
    // The fan-out was undone as a unit: no status change, no audit row for it,
    // no notification.
    expect(
      (await unsafePrismaAdmin.waitlist.findUniqueOrThrow({ where: { id: entry } })).status,
    ).toBe('pending');
    expect(await waitlistAudits()).toEqual([]);
    expect(
      await unsafePrismaAdmin.notification.count({
        where: { organizationId: fx.orgId, type: 'waitlist' },
      }),
    ).toBe(0);
  });
});
