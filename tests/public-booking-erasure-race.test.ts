import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const { submitPublicBooking } = await import('@/lib/public-booking');
const { redactedCustomerName } = await import('@/lib/redaction');
const { Client } = await import('pg');

// -----------------------------------------------------------------------------
// Public booking attaches a returning customer's booking to their existing row,
// matched on (organisation, email) or (organisation, phone). #126 made every
// staff path refuse a redacted customer under a share lock
// (lockCustomerForNewRecords). Public booking was the one path left out: it
// matched with a plain read, which returns the row as it was BEFORE an erasure
// in flight. Its insert then waited on the erasure's lock in the foreign-key
// check and, once the erasure committed, attached the booking (and the
// public form's notes) to the redacted customer. Through the retention sweep
// that is DEF-33's harm by another door: the customer who just booked is the
// one erased.
//
// After an erasure has committed nothing changes: a redacted row has no email
// or phone, so it never matches and the booking gets a new customer. The fix
// makes the in-flight case end the same way.
// -----------------------------------------------------------------------------

const stamp = Date.now();
const fx = { org: '', owner: '', loc: '', staff: '', service: '', slug: `race-${stamp}` };
let slot = 0;

/** A distinct future slot per booking, so bookings never collide with each other. */
function nextSlot(): string {
  slot += 1;
  const d = new Date(Date.now() + 3 * 24 * 3_600_000);
  d.setUTCHours(6 + slot, 0, 0, 0);
  return d.toISOString();
}

async function customer(data: { name: string; email?: string; phone?: string }) {
  return (
    await withoutRls((tx) =>
      tx.customer.create({
        data: { organizationId: fx.org, ...data },
        select: { id: true },
      }),
    )
  ).id;
}

const book = (contact: { customerEmail?: string; customerPhone?: string }) =>
  submitPublicBooking({
    slug: fx.slug,
    staffId: fx.staff,
    serviceId: fx.service,
    startsAtIso: nextSlot(),
    customerName: 'Returning Visitor',
    notes: 'left knee, mornings only',
    consented: true,
    ...contact,
  });

/** Runs `run` while another connection holds `statements`, uncommitted. */
async function whileAnotherConnectionHolds<T>(
  statements: Array<{ text: string; values?: unknown[] }>,
  run: () => Promise<T>,
): Promise<T> {
  // Same harness as tests/redacted-customer-records.test.ts: the path under
  // test must be SEEN waiting on the other connection before it commits.
  const other = new Client({ connectionString: process.env.DATABASE_URL });
  await other.connect();
  try {
    await other.query('BEGIN');
    await other.query(`SET LOCAL app.current_org_id = '${fx.org}'`);
    for (const st of statements) await other.query(st.text, st.values);
    const otherPid = (await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      .pid;
    const running = run();
    running.catch(() => undefined); // the caller asserts the outcome
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const rows = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE ${otherPid} = ANY(pg_blocking_pids(pid))`,
      );
      waiting = Number(rows[0].n) > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    expect(waiting, 'the booking never waited for the erasure').toBe(true);
    await other.query('COMMIT');
    return running;
  } finally {
    await other.end();
  }
}

/** An erasure's first steps on `id`: the row FOR UPDATE, then the redaction. */
const erasureOf = (id: string) => [
  { text: 'SELECT id FROM customers WHERE id = $1 FOR UPDATE', values: [id] },
  {
    text: 'UPDATE customers SET name = $2, email = NULL, phone = NULL WHERE id = $1',
    values: [id, redactedCustomerName(id)],
  },
];

const bookedCustomerOf = async (appointmentId: string) =>
  (
    await unsafePrismaAdmin.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      select: { customer: { select: { id: true, name: true, email: true, phone: true } } },
    })
  ).customer;

beforeAll(async () => {
  const seeded = await withoutRls(async (tx) => {
    const role = await tx.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
      select: { id: true },
    });
    const owner = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: `public-race-${stamp}@bp.test`,
        email: `public-race-${stamp}@bp.test`,
      },
      select: { id: true },
    });
    const org = await tx.organization.create({
      data: { name: `public-race-${stamp}`, status: 'active', ownerUserId: owner.id },
      select: { id: true },
    });
    await tx.membership.create({
      data: { organizationId: org.id, userId: owner.id, role: 'owner', roleId: role.id },
    });
    const loc = await tx.location.create({
      data: {
        organizationId: org.id,
        name: 'Race',
        type: 'clinic',
        timezone: 'UTC',
        publicSlug: fx.slug,
      },
      select: { id: true },
    });
    const staff = await tx.staff.create({
      data: { organizationId: org.id, locationId: loc.id, name: 'Race Dr', roleTitle: 'GP' },
      select: { id: true },
    });
    const service = await tx.service.create({
      data: {
        organizationId: org.id,
        locationId: loc.id,
        name: 'Consult',
        price: 10,
        durationMinutes: 30,
      },
      select: { id: true },
    });
    return { org: org.id, owner: owner.id, loc: loc.id, staff: staff.id, service: service.id };
  });
  Object.assign(fx, seeded);
});

afterAll(async () => {
  // Children first, including what a regression creates (an appointment on
  // the redacted row): cleanup must survive the regression it tests. The
  // organisation is archived first: the deferred org-owner trigger refuses
  // removing a live organisation's owner membership.
  await withoutRls(async (tx) => {
    await tx.organization.update({ where: { id: fx.org }, data: { status: 'archived' } });
    await tx.notification.deleteMany({ where: { organizationId: fx.org } });
    await tx.appointment.deleteMany({ where: { organizationId: fx.org } });
    await tx.customer.deleteMany({ where: { organizationId: fx.org } });
    await tx.service.deleteMany({ where: { organizationId: fx.org } });
    await tx.staff.deleteMany({ where: { organizationId: fx.org } });
    await tx.location.deleteMany({ where: { organizationId: fx.org } });
    await tx.rateLimit.deleteMany({ where: { organizationId: fx.org } });
    await tx.membership.deleteMany({ where: { organizationId: fx.org } });
  });
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs([fx.org]);
  await withoutRls(async (tx) => {
    await tx.organization.deleteMany({ where: { id: fx.org } });
    await tx.appUser.deleteMany({ where: { id: fx.owner } });
  });
});

describe('public booking and an erasure in flight', () => {
  it('COMPLEMENT: with no erasure, a returning customer is matched, case-insensitively', async () => {
    const c = await customer({ name: 'Mixed Case', email: `Returning-${stamp}@BP.test` });
    const result = await book({ customerEmail: `returning-${stamp}@bp.test` });
    const booked = await bookedCustomerOf(result.appointmentId);
    expect(booked.id).toBe(c);
    const row = await unsafePrismaAdmin.customer.findUniqueOrThrow({
      where: { id: c },
      select: { consentAt: true },
    });
    expect(row.consentAt).not.toBeNull(); // consent stamped on the matched row
  });

  it('matched by email: the booking gets a new customer, not the redacted one', async () => {
    const email = `erased-${stamp}@bp.test`;
    const c = await customer({ name: 'Erased By Email', email });
    const result = await whileAnotherConnectionHolds(erasureOf(c), () =>
      book({ customerEmail: email }),
    );
    const booked = await bookedCustomerOf(result.appointmentId);
    expect(booked.id).not.toBe(c);
    expect(booked).toMatchObject({ name: 'Returning Visitor', email });
    // Nothing new on the redacted row: no appointment, no consent stamp.
    expect(await unsafePrismaAdmin.appointment.count({ where: { customerId: c } })).toBe(0);
    expect(
      await unsafePrismaAdmin.customer.findUniqueOrThrow({
        where: { id: c },
        select: { name: true, email: true, consentAt: true },
      }),
    ).toEqual({ name: redactedCustomerName(c), email: null, consentAt: null });
  });

  it('matched by phone: the same', async () => {
    const phone = `+99559${String(stamp).slice(-7)}`;
    const c = await customer({ name: 'Erased By Phone', phone });
    const result = await whileAnotherConnectionHolds(erasureOf(c), () =>
      book({ customerPhone: phone }),
    );
    const booked = await bookedCustomerOf(result.appointmentId);
    expect(booked.id).not.toBe(c);
    expect(booked).toMatchObject({ name: 'Returning Visitor', phone });
    expect(await unsafePrismaAdmin.appointment.count({ where: { customerId: c } })).toBe(0);
  });
});
