import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin, withOrg, withoutRls } = await import('@/lib/db');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { ConflictError } = await import('@/lib/auth');
const { getAvailableSlots, isExclusionViolation } = await import('@/lib/appointments');
const { linkStaffToMember, unlinkStaff } = await import('@/lib/admin/scoped-access');
const routeList = await import('@/app/api/appointments/route');
const routeItem = await import('@/app/api/appointments/[id]/route');
const publicBook = await import('@/app/api/public/book/route');
const { bookAppointmentAction, updateAppointmentAction } =
  await import('@/components/scheduler/actions');

import type { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// Backlog A — one practitioner, one place at a time, across every staff row
// linked to them (migration 20261017000001_practitioner_double_booking).
//
// A practitioner who works at two locations of one organisation is two staff
// rows linked to one user (docs/scoped-rbac-assumption-audit.md §2). The GiST
// constraint no_staff_double_booking is keyed on the ROW, so before this
// change the same person could be booked at 10:00 at location A and at 10:00
// at location B. Every refusal below sits beside its allowed twin, and every
// refusal asserts that NOTHING was written — not merely that an error came
// back.
//
// Fixture: a dedicated organisation with two locations and its own members, so
// nothing here depends on seeded rows or their order.
// -----------------------------------------------------------------------------

type Member = { userId: string; membershipId: string };
type Fx = {
  orgId: string;
  otherOrgId: string;
  owner: Member;
  prov: Member; // the practitioner who works at both locations
  prov2: Member; // a different practitioner
  prov3: Member; // used by the link scenarios
  otherOwner: Member;
  locA: string;
  locB: string;
  otherLoc: string;
  sA: string; // prov @ A, linked
  sB: string; // prov @ B, linked
  sX: string; // prov2 @ B, linked — a different person at the same location
  sU1: string; // unlinked @ A
  sU2: string; // unlinked @ B
  sL1: string; // unlinked @ A, linked to prov3 by the link tests
  sL2: string; // unlinked @ B, linked to prov3 by the link tests
  sOther: string; // prov @ the OTHER organisation, linked
  customer: string;
  otherCustomer: string;
  svcA: string; // 60 minutes @ A
  svcB: string; // 60 minutes @ B
  slugB: string;
};
let fx: Fx;
const ts = Date.now();
const createdUsers: string[] = [];

// A fixed far-future day. No availability is configured on these rows, which is
// the legacy fail-open path (07:00–21:00 local in the picker, no window check on
// write) — exactly what isolates the double-booking decision from availability.
const DAY = '2031-03-04';
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00Z`);

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

/** Insert one appointment through the RUNTIME role, under RLS, as the app does. */
async function book(
  staffId: string,
  locationId: string,
  from: string,
  to: string,
  opts: { orgId?: string; customerId?: string; status?: 'pending' | 'cancelled' } = {},
): Promise<string> {
  const orgId = opts.orgId ?? fx.orgId;
  const row = await withOrg(orgId, (tx) =>
    tx.appointment.create({
      data: {
        organizationId: orgId,
        locationId,
        customerId: opts.customerId ?? fx.customer,
        staffId,
        startsAt: at(from),
        endsAt: at(to),
        serviceName: 'PDB',
        price: 10,
        status: opts.status ?? 'pending',
      },
      select: { id: true },
    }),
  );
  return row.id;
}

async function expectRefused(p: Promise<unknown>, constraint: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected a refusal from ${constraint}`).not.toBeNull();
  expect(isExclusionViolation(err), 'must classify as a double-booking (23P01)').toBe(true);
  expect(String((err as Error).message)).toContain(constraint);
}

async function countAt(staffIds: string[]): Promise<number> {
  return unsafePrismaAdmin.appointment.count({
    where: { staffId: { in: staffIds }, startsAt: { gte: at('00:00'), lt: at('23:59') } },
  });
}

async function clearDay() {
  await unsafePrismaAdmin.appointment.deleteMany({
    where: { organizationId: { in: [fx.orgId, fx.otherOrgId] } },
  });
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
    const rOwner = await role('ORG_OWNER');
    const rProv = await role('PROVIDER');
    const org = await tx.organization.create({ data: { name: `PDB Org ${ts}` } });
    const other = await tx.organization.create({ data: { name: `PDB Other ${ts}` } });
    const user = async (tag: string) => {
      const u = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `pdb-${tag}-${ts}@bookpitch.dev`,
          email: `pdb-${tag}-${ts}@bookpitch.dev`,
        },
        select: { id: true },
      });
      createdUsers.push(u.id);
      return u.id;
    };
    const member = async (
      orgId: string,
      userId: string,
      legacy: 'owner' | 'practitioner',
      roleId: string,
    ): Promise<Member> => ({
      userId,
      membershipId: (
        await tx.membership.create({
          data: { organizationId: orgId, userId, role: legacy, roleId },
          select: { id: true },
        })
      ).id,
    });

    const ownerId = await user('owner');
    const provId = await user('prov');
    const prov2Id = await user('prov2');
    const prov3Id = await user('prov3');
    const otherOwnerId = await user('other-owner');
    const owner = await member(org.id, ownerId, 'owner', rOwner);
    const prov = await member(org.id, provId, 'practitioner', rProv);
    const prov2 = await member(org.id, prov2Id, 'practitioner', rProv);
    const prov3 = await member(org.id, prov3Id, 'practitioner', rProv);
    const otherOwner = await member(other.id, otherOwnerId, 'owner', rOwner);
    // The same practitioner is ALSO a member of another organisation.
    await member(other.id, provId, 'practitioner', rProv);
    await tx.organization.update({ where: { id: org.id }, data: { ownerUserId: ownerId } });
    await tx.organization.update({ where: { id: other.id }, data: { ownerUserId: otherOwnerId } });

    const slugB = `pdb-b-${ts}`;
    const loc = (orgId: string, name: string, publicSlug?: string) =>
      tx.location.create({
        data: { organizationId: orgId, type: 'clinic', name, publicSlug },
        select: { id: true },
      });
    const locA = (await loc(org.id, 'PDB A')).id;
    const locB = (await loc(org.id, 'PDB B', slugB)).id;
    const otherLoc = (await loc(other.id, 'PDB Other')).id;

    const staff = (orgId: string, locationId: string, name: string, userId?: string) =>
      tx.staff.create({
        data: { organizationId: orgId, locationId, name, roleTitle: 'Clinician', userId },
        select: { id: true },
      });
    const svc = (locationId: string) =>
      tx.service.create({
        data: {
          organizationId: org.id,
          locationId,
          name: 'PDB Consult',
          price: 10,
          durationMinutes: 60,
        },
        select: { id: true },
      });

    return {
      orgId: org.id,
      otherOrgId: other.id,
      owner,
      prov,
      prov2,
      prov3,
      otherOwner,
      locA,
      locB,
      otherLoc,
      sA: (await staff(org.id, locA, 'PDB Prov @A', provId)).id,
      sB: (await staff(org.id, locB, 'PDB Prov @B', provId)).id,
      sX: (await staff(org.id, locB, 'PDB Prov2 @B', prov2Id)).id,
      sU1: (await staff(org.id, locA, 'PDB Unlinked @A')).id,
      sU2: (await staff(org.id, locB, 'PDB Unlinked @B')).id,
      sL1: (await staff(org.id, locA, 'PDB Link @A')).id,
      sL2: (await staff(org.id, locB, 'PDB Link @B')).id,
      sOther: (await staff(other.id, otherLoc, 'PDB Prov @Other', provId)).id,
      customer: (await tx.customer.create({ data: { organizationId: org.id, name: 'PDB C' } })).id,
      otherCustomer: (
        await tx.customer.create({ data: { organizationId: other.id, name: 'PDB OC' } })
      ).id,
      svcA: (await svc(locA)).id,
      svcB: (await svc(locB)).id,
      slugB,
    };
  });
});

afterAll(async () => {
  if (!fx) return;
  const orgs = [fx.orgId, fx.otherOrgId];
  await withoutRls(async (tx) => {
    await tx.notification.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.appointment.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.service.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.customer.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.staff.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.location.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.membership.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.rateLimit.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.organization.updateMany({ where: { id: { in: orgs } }, data: { ownerUserId: null } });
  });
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs(orgs);
  await withoutRls(async (tx) => {
    await tx.appUser.deleteMany({ where: { id: { in: createdUsers } } });
    await tx.organization.deleteMany({ where: { id: { in: orgs } } });
  });
});

beforeEach(async () => {
  authMock.mockReset();
  __clearAuthContextCache();
  await clearDay();
});

// -----------------------------------------------------------------------------
// The guard itself, exercised as the runtime role (bookpitch_app, RLS on).
// -----------------------------------------------------------------------------
describe('the practitioner guard, as the runtime role', () => {
  it('refuses an overlapping booking at the other location — and writes nothing', async () => {
    await book(fx.sA, fx.locA, '10:00', '11:00');
    await expectRefused(book(fx.sB, fx.locB, '10:30', '11:30'), 'no_practitioner_double_booking');
    expect(await countAt([fx.sB])).toBe(0);
  });

  it('refuses a booking that CONTAINS the other one, and one contained BY it', async () => {
    await book(fx.sA, fx.locA, '10:00', '11:00');
    await expectRefused(book(fx.sB, fx.locB, '09:00', '12:00'), 'no_practitioner_double_booking');
    await expectRefused(book(fx.sB, fx.locB, '10:15', '10:45'), 'no_practitioner_double_booking');
    expect(await countAt([fx.sB])).toBe(0);
  });

  it('allows the same practitioner at two locations when the times do not overlap', async () => {
    await book(fx.sA, fx.locA, '10:00', '11:00');
    // Half-open, exactly like tstzrange in no_staff_double_booking: back to back is fine.
    await book(fx.sB, fx.locB, '11:00', '12:00');
    await book(fx.sB, fx.locB, '08:00', '10:00');
    expect(await countAt([fx.sA, fx.sB])).toBe(3);
  });

  it('leaves the per-row constraint in charge of same-row overlaps', async () => {
    await book(fx.sA, fx.locA, '10:00', '11:00');
    await expectRefused(book(fx.sA, fx.locA, '10:30', '11:30'), 'no_staff_double_booking');
    expect(await countAt([fx.sA])).toBe(1);
  });

  it('does not stop two DIFFERENT practitioners overlapping at one location', async () => {
    await book(fx.sB, fx.locB, '10:00', '11:00'); // prov
    await book(fx.sX, fx.locB, '10:00', '11:00'); // prov2
    expect(await countAt([fx.sB, fx.sX])).toBe(2);
  });

  it('does not guess identity: two UNLINKED rows are not assumed to be one person', async () => {
    await book(fx.sU1, fx.locA, '10:00', '11:00');
    await book(fx.sU2, fx.locB, '10:00', '11:00');
    expect(await countAt([fx.sU1, fx.sU2])).toBe(2);
  });

  it('a cancelled booking occupies nobody — and reactivating it into a clash is refused', async () => {
    const cancelled = await book(fx.sA, fx.locA, '10:00', '11:00', { status: 'cancelled' });
    // The freed time can be taken at the other location.
    await book(fx.sB, fx.locB, '10:00', '11:00');
    // Bringing the cancelled one back would put the practitioner in two places.
    await expectRefused(
      withOrg(fx.orgId, (tx) =>
        tx.appointment.update({ where: { id: cancelled }, data: { status: 'confirmed' } }),
      ),
      'no_practitioner_double_booking',
    );
    const row = await unsafePrismaAdmin.appointment.findUniqueOrThrow({ where: { id: cancelled } });
    expect(row.status).toBe('cancelled');
  });

  it('refuses a reschedule INTO a clash and leaves the row where it was', async () => {
    await book(fx.sA, fx.locA, '10:00', '11:00');
    const movable = await book(fx.sB, fx.locB, '14:00', '15:00');
    await expectRefused(
      withOrg(fx.orgId, (tx) =>
        tx.appointment.update({
          where: { id: movable },
          data: { startsAt: at('10:30'), endsAt: at('11:30') },
        }),
      ),
      'no_practitioner_double_booking',
    );
    const row = await unsafePrismaAdmin.appointment.findUniqueOrThrow({ where: { id: movable } });
    expect(row.startsAt.toISOString()).toBe(at('14:00').toISOString());

    // Its twin: a reschedule that does not clash goes through.
    await withOrg(fx.orgId, (tx) =>
      tx.appointment.update({
        where: { id: movable },
        data: { startsAt: at('11:00'), endsAt: at('12:00') },
      }),
    );
  });

  it('keeps tenants apart: the same person in another organisation is a separate calendar', async () => {
    await book(fx.sA, fx.locA, '10:00', '11:00');
    // Refusing this would disclose org A's calendar to org B.
    await book(fx.sOther, fx.otherLoc, '10:00', '11:00', {
      orgId: fx.otherOrgId,
      customerId: fx.otherCustomer,
    });
    expect(await countAt([fx.sA, fx.sOther])).toBe(2);
  });

  it('an edit that does not move a booking never re-decides it', async () => {
    // A pre-existing overlap: two PAST bookings, made while the rows were not
    // yet linked. A past-only overlap does not block the link (see below), and
    // afterwards a notes or payment edit on either row must still succeed —
    // otherwise an unrelated edit would fail on a clash it did not create.
    const past = '2026-01-05';
    const mk = (staffId: string, loc: string) =>
      withOrg(fx.orgId, (tx) =>
        tx.appointment.create({
          data: {
            organizationId: fx.orgId,
            locationId: loc,
            customerId: fx.customer,
            staffId,
            startsAt: new Date(`${past}T10:00:00Z`),
            endsAt: new Date(`${past}T11:00:00Z`),
            serviceName: 'PDB',
            price: 10,
          },
          select: { id: true },
        }),
      );
    const p1 = (await mk(fx.sL1, fx.locA)).id;
    await mk(fx.sL2, fx.locB);
    const ownerSession = { ...fx.owner, email: 'o@x.invalid', organizationId: fx.orgId };
    await linkStaffToMember(ownerSession, fx.sL1, fx.prov3.userId);
    await linkStaffToMember(ownerSession, fx.sL2, fx.prov3.userId);
    try {
      // Through the real PATCH route, which always writes staffId, startsAt and
      // endsAt back (unchanged) alongside the edit — so the trigger FIRES and
      // must decide not to re-decide. A notes-only Prisma update would not
      // fire this column-scoped trigger at all and would prove nothing.
      authMock.mockResolvedValue(await mockJwt(fx.owner.userId, fx.orgId));
      const res = await routeItem.PATCH(
        req(`http://localhost/api/appointments/${p1}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ notes: 'edited', paymentStatus: 'paid' }),
        }),
        { params: Promise.resolve({ id: p1 }) },
      );
      expect(res.status).toBe(200);
      const row = await unsafePrismaAdmin.appointment.findUniqueOrThrow({ where: { id: p1 } });
      expect(row.notes).toBe('edited');
      expect(row.paymentStatus).toBe('paid');

      // Its complement: MOVING that same past booking is a new decision, and
      // its twin on the other row now counts — so the move is refused.
      await expectRefused(
        withOrg(fx.orgId, (tx) =>
          tx.appointment.update({
            where: { id: p1 },
            data: {
              startsAt: new Date(`${past}T10:15:00Z`),
              endsAt: new Date(`${past}T11:15:00Z`),
            },
          }),
        ),
        'no_practitioner_double_booking',
      );
    } finally {
      await unlinkStaff(ownerSession, fx.sL1);
      await unlinkStaff(ownerSession, fx.sL2);
    }
  });
});

// -----------------------------------------------------------------------------
// Concurrency. Two connections, one practitioner, two locations, same time.
// -----------------------------------------------------------------------------
describe('concurrent bookings for one practitioner', () => {
  async function appClient(): Promise<Client> {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    return c;
  }
  const insertSql = (staffId: string, locationId: string, from: string, to: string) => ({
    text: `INSERT INTO appointments (organization_id, location_id, customer_id, staff_id,
                                     starts_at, ends_at, service_name, price)
           VALUES ($1, $2, $3, $4, $5, $6, 'PDB', 10)`,
    values: [fx.orgId, locationId, fx.customer, staffId, at(from), at(to)],
  });

  async function waitUntilBlocked(pid: number): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const rows = await unsafePrismaAdmin.$queryRawUnsafe<
        Array<{ wait_event_type: string | null; wait_event: string | null }>
      >(`SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = ${pid}`);
      const w = rows[0];
      if (w?.wait_event_type === 'Lock') return `${w.wait_event_type}/${w.wait_event}`;
      await new Promise((r) => setTimeout(r, 50));
    }
    return 'not blocked';
  }

  it('the second waits for the first, then is refused once the first commits', async () => {
    const c1 = await appClient();
    const c2 = await appClient();
    try {
      await c1.query('BEGIN');
      await c1.query(`SET LOCAL app.current_org_id = '${fx.orgId}'`);
      await c2.query('BEGIN');
      await c2.query(`SET LOCAL app.current_org_id = '${fx.orgId}'`);
      const pid2 = (await c2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;

      await c1.query(insertSql(fx.sA, fx.locA, '10:00', '11:00'));
      const second = c2.query(insertSql(fx.sB, fx.locB, '10:30', '11:30')).then(
        () => 'committed-insert',
        (e: { code?: string; constraint?: string }) => `${e.code}:${e.constraint}`,
      );
      // It must be WAITING on the practitioner lock — not racing past it.
      expect(await waitUntilBlocked(pid2)).toBe('Lock/advisory');
      await c1.query('COMMIT');
      expect(await second).toBe('23P01:no_practitioner_double_booking');
      await c2.query('ROLLBACK');
    } finally {
      await c1.end();
      await c2.end();
    }
    expect(await countAt([fx.sA, fx.sB])).toBe(1);
  });

  it('the second goes through when the first rolls back', async () => {
    const c1 = await appClient();
    const c2 = await appClient();
    try {
      await c1.query('BEGIN');
      await c1.query(`SET LOCAL app.current_org_id = '${fx.orgId}'`);
      await c2.query('BEGIN');
      await c2.query(`SET LOCAL app.current_org_id = '${fx.orgId}'`);
      const pid2 = (await c2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;

      await c1.query(insertSql(fx.sA, fx.locA, '10:00', '11:00'));
      const second = c2.query(insertSql(fx.sB, fx.locB, '10:30', '11:30'));
      expect(await waitUntilBlocked(pid2)).toBe('Lock/advisory');
      await c1.query('ROLLBACK');
      await second;
      await c2.query('COMMIT');
    } finally {
      await c1.end();
      await c2.end();
    }
    expect(await countAt([fx.sA])).toBe(0);
    expect(await countAt([fx.sB])).toBe(1);
  });

  it('refuses to decide under REPEATABLE READ rather than decide on a stale snapshot', async () => {
    // The lock only helps if the query after it can SEE what the previous
    // holder committed. Under REPEATABLE READ the snapshot predates the wait,
    // so the trigger fails closed (55000) instead of guessing. No code path
    // sets that level today; this pins the tripwire if one ever does.
    const c = await appClient();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await c.query(`SET LOCAL app.current_org_id = '${fx.orgId}'`);
      const err = await c.query(insertSql(fx.sB, fx.locB, '10:00', '11:00')).then(
        () => null,
        (e: { code?: string }) => e,
      );
      expect(err?.code).toBe('55000');
      await c.query('ROLLBACK');

      // An UNLINKED row takes no lock, so it has nothing to be stale about.
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await c.query(`SET LOCAL app.current_org_id = '${fx.orgId}'`);
      await c.query(insertSql(fx.sU2, fx.locB, '10:00', '11:00'));
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('two simultaneous API bookings at two locations: exactly one is booked', async () => {
    authMock.mockResolvedValue(await mockJwt(fx.owner.userId, fx.orgId));
    const post = (staffId: string, locationId: string, serviceId: string) =>
      routeList.POST(
        req('http://localhost/api/appointments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            locationId,
            customerId: fx.customer,
            staffId,
            serviceId,
            startsAt: at('10:00').toISOString(),
          }),
        }),
      );
    const statuses = (
      await Promise.all([post(fx.sA, fx.locA, fx.svcA), post(fx.sB, fx.locB, fx.svcB)])
    ).map((r) => r.status);
    // withApi answers a successful create with 200 (no route here sets 201).
    expect(statuses.sort()).toEqual([200, 409]);
    expect(await countAt([fx.sA, fx.sB])).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Linking two rows is what makes them one practitioner.
// -----------------------------------------------------------------------------
describe('linking a staff row cannot create the double-booking', () => {
  const session = () => ({ ...fx.owner, email: 'o@x.invalid', organizationId: fx.orgId });

  async function linkAudits(staffId: string): Promise<number> {
    return unsafePrismaAdmin.auditLog.count({
      where: { organizationId: fx.orgId, entity: 'staff', entityId: staffId },
    });
  }

  it('refuses the link when an UPCOMING booking would overlap — no link, no audit row', async () => {
    await linkStaffToMember(session(), fx.sL1, fx.prov3.userId);
    try {
      await book(fx.sL1, fx.locA, '10:00', '11:00');
      await book(fx.sL2, fx.locB, '10:30', '11:30'); // sL2 is unlinked: allowed today
      const auditsBefore = await linkAudits(fx.sL2);

      const err = await linkStaffToMember(session(), fx.sL2, fx.prov3.userId).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(String(err.message)).toMatch(/double-book/);

      const row = await unsafePrismaAdmin.staff.findUniqueOrThrow({ where: { id: fx.sL2 } });
      expect(row.userId).toBeNull();
      expect(await linkAudits(fx.sL2)).toBe(auditsBefore);

      // Its twin: once the clash is moved, the same link goes through.
      await unsafePrismaAdmin.appointment.updateMany({
        where: { staffId: fx.sL2 },
        data: { startsAt: at('12:00'), endsAt: at('13:00') },
      });
      await linkStaffToMember(session(), fx.sL2, fx.prov3.userId);
      expect(
        (await unsafePrismaAdmin.staff.findUniqueOrThrow({ where: { id: fx.sL2 } })).userId,
      ).toBe(fx.prov3.userId);
    } finally {
      await unlinkStaff(session(), fx.sL1);
      await unlinkStaff(session(), fx.sL2);
    }
  });

  it('after an unlink the rows are two calendars again', async () => {
    await linkStaffToMember(session(), fx.sL1, fx.prov3.userId);
    await linkStaffToMember(session(), fx.sL2, fx.prov3.userId);
    await book(fx.sL1, fx.locA, '10:00', '11:00');
    await expectRefused(book(fx.sL2, fx.locB, '10:00', '11:00'), 'no_practitioner_double_booking');
    await unlinkStaff(session(), fx.sL2);
    await book(fx.sL2, fx.locB, '10:00', '11:00');
    await unlinkStaff(session(), fx.sL1);
    expect(await countAt([fx.sL1, fx.sL2])).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Every write path answers 409 slot_taken — never a 500 — and writes nothing.
// -----------------------------------------------------------------------------
describe('every booking path refuses with slot_taken and leaves no trace', () => {
  async function traces() {
    const [appts, audits, notifications] = await Promise.all([
      unsafePrismaAdmin.appointment.count({ where: { organizationId: fx.orgId } }),
      unsafePrismaAdmin.auditLog.count({
        where: { organizationId: fx.orgId, entity: 'appointment', action: 'create' },
      }),
      unsafePrismaAdmin.notification.count({ where: { organizationId: fx.orgId } }),
    ]);
    return { appts, audits, notifications };
  }

  it('POST /api/appointments', async () => {
    await book(fx.sA, fx.locA, '10:00', '11:00');
    authMock.mockResolvedValue(await mockJwt(fx.owner.userId, fx.orgId));
    const before = await traces();
    const res = await routeList.POST(
      req('http://localhost/api/appointments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locationId: fx.locB,
          customerId: fx.customer,
          staffId: fx.sB,
          serviceId: fx.svcB,
          startsAt: at('10:30').toISOString(),
        }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/slot/i) });
    expect(await traces()).toEqual(before);
  });

  it('PATCH /api/appointments/[id] — a reschedule into the clash', async () => {
    await book(fx.sA, fx.locA, '10:00', '11:00');
    const movable = await book(fx.sB, fx.locB, '14:00', '15:00');
    authMock.mockResolvedValue(await mockJwt(fx.owner.userId, fx.orgId));
    const res = await routeItem.PATCH(
      req(`http://localhost/api/appointments/${movable}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startsAt: at('10:30').toISOString() }),
      }),
      { params: Promise.resolve({ id: movable }) },
    );
    expect(res.status).toBe(409);
    const row = await unsafePrismaAdmin.appointment.findUniqueOrThrow({ where: { id: movable } });
    expect(row.startsAt.toISOString()).toBe(at('14:00').toISOString());
  });

  it('bookAppointmentAction and updateAppointmentAction return slot_taken', async () => {
    await book(fx.sA, fx.locA, '10:00', '11:00');
    const movable = await book(fx.sB, fx.locB, '14:00', '15:00');
    authMock.mockResolvedValue(await mockJwt(fx.owner.userId, fx.orgId));
    const before = await traces();
    expect(
      await bookAppointmentAction({
        locationId: fx.locB,
        customerId: fx.customer,
        staffId: fx.sB,
        serviceId: fx.svcB,
        startsAt: at('10:30').toISOString(),
      }),
    ).toEqual({ ok: false, error: 'slot_taken' });
    expect(await updateAppointmentAction(movable, { startsAt: at('10:30').toISOString() })).toEqual(
      { ok: false, error: 'slot_taken' },
    );
    expect(await traces()).toEqual(before);
  });

  it('POST /api/public/book — the anonymous widget, customer row included', async () => {
    await book(fx.sA, fx.locA, '10:00', '11:00');
    const email = `pdb-public-${ts}@example.invalid`;
    const res = await publicBook.POST(
      req('http://localhost/api/public/book', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: fx.slugB,
          staffId: fx.sB,
          serviceId: fx.svcB,
          startsAt: at('10:30').toISOString(),
          customerName: 'Public Person',
          customerEmail: email,
          consented: true,
        }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'slot_taken' });
    // The customer row is created in the same transaction — it must be gone too.
    expect(await unsafePrismaAdmin.customer.count({ where: { email } })).toBe(0);
    expect(await countAt([fx.sB])).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Authorisation is decided before the guard is ever reached.
// -----------------------------------------------------------------------------
describe('authorisation around the guard is unchanged', () => {
  it('an unauthenticated booking is 401 and writes nothing', async () => {
    authMock.mockResolvedValue(null);
    const res = await routeList.POST(
      req('http://localhost/api/appointments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locationId: fx.locB,
          customerId: fx.customer,
          staffId: fx.sB,
          serviceId: fx.svcB,
          startsAt: at('10:30').toISOString(),
        }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await countAt([fx.sB])).toBe(0);
  });

  it("a PROVIDER cannot move a colleague's booking (403) — even to a free time", async () => {
    const theirs = await book(fx.sB, fx.locB, '14:00', '15:00'); // prov's
    authMock.mockResolvedValue(await mockJwt(fx.prov2.userId, fx.orgId));
    const res = await routeItem.PATCH(
      req(`http://localhost/api/appointments/${theirs}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startsAt: at('16:00').toISOString() }),
      }),
      { params: Promise.resolve({ id: theirs }) },
    );
    expect(res.status).toBe(403);
    const row = await unsafePrismaAdmin.appointment.findUniqueOrThrow({ where: { id: theirs } });
    expect(row.startsAt.toISOString()).toBe(at('14:00').toISOString());
  });

  it("another organisation's booking id is not found (404), not a conflict", async () => {
    const foreign = await book(fx.sOther, fx.otherLoc, '10:00', '11:00', {
      orgId: fx.otherOrgId,
      customerId: fx.otherCustomer,
    });
    authMock.mockResolvedValue(await mockJwt(fx.owner.userId, fx.orgId));
    const res = await routeItem.PATCH(
      req(`http://localhost/api/appointments/${foreign}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startsAt: at('12:00').toISOString() }),
      }),
      { params: Promise.resolve({ id: foreign }) },
    );
    expect(res.status).toBe(404);
  });
});

// -----------------------------------------------------------------------------
// The picker agrees with the write path.
// -----------------------------------------------------------------------------
describe('the slot picker agrees with the write path', () => {
  // Locations default to Asia/Tbilisi (UTC+4): 10:00Z is 14:00 on the clinic wall.
  const TZ = 'Asia/Tbilisi';
  const slotsFor = (staffId: string, exclude?: string) =>
    withOrg(fx.orgId, (tx) => getAvailableSlots(tx, staffId, DAY, 60, TZ, exclude));

  it("hides the practitioner's booking at the other location", async () => {
    expect(await slotsFor(fx.sB)).toEqual(expect.arrayContaining(['13:30', '14:00', '14:30']));
    await book(fx.sA, fx.locA, '10:00', '11:00'); // 14:00–15:00 local
    const slots = await slotsFor(fx.sB);
    for (const taken of ['13:30', '14:00', '14:30']) expect(slots).not.toContain(taken);
    for (const free of ['13:00', '15:00']) expect(slots).toContain(free);
  });

  it('an unlinked row sees only its own bookings', async () => {
    await book(fx.sU1, fx.locA, '10:00', '11:00');
    expect(await slotsFor(fx.sU2)).toContain('14:00');
  });

  it("another organisation's bookings never shape this one's picker", async () => {
    await book(fx.sOther, fx.otherLoc, '10:00', '11:00', {
      orgId: fx.otherOrgId,
      customerId: fx.otherCustomer,
    });
    expect(await slotsFor(fx.sB)).toContain('14:00');
  });

  it('a reschedule does not block itself, across rows either', async () => {
    const own = await book(fx.sA, fx.locA, '10:00', '11:00');
    expect(await slotsFor(fx.sB, own)).toContain('14:00');
  });
});
