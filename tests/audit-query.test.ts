import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls, withOrg } = await import('@/lib/db');
const { queryAudit } = await import('@/lib/audit-query');

describe('queryAudit — filters + ordering + customerName resolution', () => {
  let orgId: string;
  let actorId: string;
  let customerId: string;
  const plantedIds: bigint[] = [];

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `audit-q-${Date.now()}` } });
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `audit-q-${Date.now()}@ex.dev`,
          email: `audit-q-${Date.now()}@ex.dev`,
          fullName: 'Q Owner',
          passwordHash: 'x',
        },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: user.id, role: 'owner' },
      });
      const customer = await tx.customer.create({
        data: { organizationId: org.id, name: 'Audit Target' },
      });
      const t0 = new Date('2027-01-01T10:00:00Z');
      const t1 = new Date('2027-01-02T10:00:00Z');
      const t2 = new Date('2027-01-03T10:00:00Z');
      const a1 = await tx.auditLog.create({
        data: {
          organizationId: org.id,
          actorUserId: user.id,
          action: 'create',
          entity: 'customer',
          entityId: customer.id,
          at: t0,
        },
      });
      const a2 = await tx.auditLog.create({
        data: {
          organizationId: org.id,
          actorUserId: user.id,
          action: 'update',
          entity: 'customer',
          entityId: customer.id,
          at: t1,
        },
      });
      const a3 = await tx.auditLog.create({
        data: {
          organizationId: org.id,
          actorUserId: user.id,
          action: 'create',
          entity: 'appointment',
          entityId: null,
          at: t2,
        },
      });
      plantedIds.push(a1.id, a2.id, a3.id);
      return { org, user, customer };
    });
    orgId = seed.org.id;
    actorId = seed.user.id;
    customerId = seed.customer.id;
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      if (plantedIds.length)
        await tx.auditLog.deleteMany({ where: { id: { in: plantedIds } } });
      await tx.customer.delete({ where: { id: customerId } });
      await tx.membership.deleteMany({ where: { userId: actorId } });
      await tx.appUser.delete({ where: { id: actorId } });
      await tx.organization.delete({ where: { id: orgId } });
    });
  });

  it('returns rows for the org, newest first', async () => {
    const rows = await withOrg(orgId, (tx) => queryAudit(tx, {}));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // Newest first — appointment (t2) precedes customer update (t1)
    const first = rows[0];
    expect(first.entity).toBe('appointment');
  });

  it('filters by entity + resolves customerName for entity="customer"', async () => {
    const rows = await withOrg(orgId, (tx) => queryAudit(tx, { entity: 'customer' }));
    expect(rows.every((r) => r.entity === 'customer')).toBe(true);
    // Only the rows whose entityId matches our planted customer should
    // resolve the name; the org may also contain older customer audit rows
    // for customers that were later deleted.
    const mine = rows.filter((r) => r.entityId === customerId);
    expect(mine.length).toBe(2);
    expect(mine.every((r) => r.customerName === 'Audit Target')).toBe(true);
  });

  it('filters by action', async () => {
    const rows = await withOrg(orgId, (tx) => queryAudit(tx, { action: 'update' }));
    expect(rows.every((r) => r.action === 'update')).toBe(true);
  });

  it('filters by date range (inclusive)', async () => {
    const rows = await withOrg(orgId, (tx) =>
      queryAudit(tx, {
        fromDate: new Date('2027-01-02T00:00:00Z'),
        toDate: new Date('2027-01-02T23:59:59Z'),
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.at.startsWith('2027-01-02'))).toBe(true);
  });

  it('honors the limit', async () => {
    const rows = await withOrg(orgId, (tx) => queryAudit(tx, { limit: 1 }));
    expect(rows.length).toBe(1);
  });
});
