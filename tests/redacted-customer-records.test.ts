import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const { addToWaitlist } = await import('@/lib/waitlist');
const { anonymizeCustomer, runRetentionTick } = await import('@/lib/gdpr');
const { erasedNamePseudonym } = await import('@/lib/crypto');
const { redactedCustomerName } = await import('@/lib/redaction');
const { InvalidInputError, ctxToSession } = await import('@/lib/auth');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { requireAuthContext } = await import('@/lib/rbac');
const { Client } = await import('pg');

// -----------------------------------------------------------------------------
// Codex review on #126 (2026-10-24). Three races between an erasure and
// another write to the same customer, each run for real: another connection
// holds its transaction open until the path under test is seen waiting on it
// (pg_blocking_pids), then commits.
//
// 1. A waitlist add that had passed its existence check waited on the
//    erasure's lock in its foreign-key check, then inserted new notes for a
//    redacted customer.
// 2. The erasure hashed the name it read BEFORE taking its lock, so a rename
//    committed in between was hashed stale while the new name was cleared.
// 3. The retention sweep erased a customer who booked while it ran: the
//    candidates are read without a lock, and nothing asked again under one.
// -----------------------------------------------------------------------------
const stamp = Date.now();
const fx = { org: '', owner: '', loc: '', staff: '' };
let session: ReturnType<typeof ctxToSession>;
const WINDOW = {
  preferredFrom: new Date('2031-05-01T00:00:00Z'),
  preferredTo: new Date('2031-05-31T00:00:00Z'),
};

async function customer(name: string, updatedAt?: Date) {
  return (
    await withoutRls((tx) =>
      tx.customer.create({
        // updatedAt is backdated on INSERT: set_updated_at rewrites it on UPDATE.
        data: { organizationId: fx.org, name, email: `${stamp}-${name.length}@bp.test`, updatedAt },
        select: { id: true },
      }),
    )
  ).id;
}

/** Runs `run` while another connection holds `statements`, uncommitted. */
async function whileAnotherConnectionHolds<T>(
  statements: Array<{ text: string; values?: unknown[] }>,
  run: () => Promise<T>,
): Promise<T> {
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
    expect(waiting, 'the path under test never waited for the other connection').toBe(true);
    await other.query('COMMIT');
    return running;
  } finally {
    await other.end();
  }
}

beforeAll(async () => {
  const seeded = await withoutRls(async (tx) => {
    const role = await tx.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
      select: { id: true },
    });
    // Archived: a live ownerless organisation breaks the ownership invariant.
    const org = await tx.organization.create({
      data: { name: `redacted-writes-${stamp}`, status: 'archived' },
      select: { id: true },
    });
    const owner = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: `redacted-writes-${stamp}@bp.test`,
        email: `redacted-writes-${stamp}@bp.test`,
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

afterAll(async () => {
  await withoutRls(async (tx) => {
    await tx.waitlist.deleteMany({ where: { organizationId: fx.org } });
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

describe('a redacted customer gets no new waitlist entry', () => {
  it('refused once redacted; a live customer is added (COMPLEMENT)', async () => {
    const gone = await customer('Already Erased');
    await anonymizeCustomer(session, gone, 'gdpr');
    await expect(
      addToWaitlist(session, { customerId: gone, ...WINDOW, notes: 'calls after 5pm' }),
    ).rejects.toThrow(/anonymized/);
    const live = await customer('Still Here');
    await expect(addToWaitlist(session, { customerId: live, ...WINDOW })).resolves.toHaveProperty(
      'id',
    );
    expect(await unsafePrismaAdmin.waitlist.count({ where: { customerId: gone } })).toBe(0);
  });

  it('an add that waits on an erasure is refused when the erasure commits', async () => {
    const c = await customer('Erased Mid Add');
    // The erasure's first step (the customer row, FOR UPDATE) and its rename.
    const adding = whileAnotherConnectionHolds(
      [
        { text: 'SELECT id FROM customers WHERE id = $1 FOR UPDATE', values: [c] },
        {
          text: 'UPDATE customers SET name = $2, email = NULL, phone = NULL WHERE id = $1',
          values: [c, redactedCustomerName(c)],
        },
      ],
      () => addToWaitlist(session, { customerId: c, ...WINDOW, notes: 'knee, mornings only' }),
    );
    await expect(adding).rejects.toBeInstanceOf(InvalidInputError);
    await expect(adding).rejects.toThrow(/anonymized/);
    expect(await unsafePrismaAdmin.waitlist.count({ where: { customerId: c } })).toBe(0);
  });
});

describe("the erasure's pseudonym is of the name it clears", () => {
  it('a rename committed while the erasure waits is the name hashed', async () => {
    const c = await customer('Name Before');
    await whileAnotherConnectionHolds(
      [{ text: 'UPDATE customers SET name = $2 WHERE id = $1', values: [c, 'Name After'] }],
      () => anonymizeCustomer(session, c, 'gdpr'),
    );
    const own = await unsafePrismaAdmin.auditLog.findFirstOrThrow({
      where: { organizationId: fx.org, entity: 'customer', entityId: c },
      select: { meta: true },
    });
    const hmac = (own.meta as { previousNameHmac: string }).previousNameHmac;
    expect(hmac).toBe(erasedNamePseudonym('Name After'));
    expect(hmac).not.toBe(erasedNamePseudonym('Name Before'));
  });
});

describe('the retention sweep asks again under the lock', () => {
  it('a customer who books while it runs is left alone; an idle one is not (COMPLEMENT)', async () => {
    const longAgo = new Date('2015-01-01T00:00:00Z');
    const booking = await customer('Books During Sweep', longAgo);
    const idle = await customer('Idle Throughout', longAgo);
    const report = await whileAnotherConnectionHolds(
      [
        {
          text: `INSERT INTO appointments (organization_id, location_id, customer_id, staff_id,
                                           starts_at, ends_at, service_name, price, status)
                 VALUES ($1, $2, $3, $4, now() + interval '1 day',
                         now() + interval '1 day 30 minutes', 'Comeback', 10, 'confirmed')`,
          values: [fx.org, fx.loc, booking, fx.staff],
        },
      ],
      () => runRetentionTick(fx.org),
    );
    expect(report.anonymizedIds).toContain(idle);
    expect(report.anonymizedIds).not.toContain(booking);
    const kept = await unsafePrismaAdmin.customer.findUniqueOrThrow({
      where: { id: booking },
      select: { name: true },
    });
    expect(kept.name).toBe('Books During Sweep');
  });
});
