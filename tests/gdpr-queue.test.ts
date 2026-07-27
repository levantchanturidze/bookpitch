import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls, withOrg } = await import('@/lib/db');
const { recentDsrActivity, dsrDeadlineDays } = await import('@/lib/gdpr-queue');

describe('recentDsrActivity — SLA clock + customer-name resolution', () => {
  let orgId: string;
  let customerId: string;
  const plantedIds: bigint[] = [];

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `dsr-${Date.now()}` } });
      const customer = await tx.customer.create({
        data: { organizationId: org.id, name: 'DSR Target' },
      });
      const older = new Date(Date.now() - 40 * 24 * 3600 * 1000);
      const recent = new Date();
      const a1 = await tx.auditLog.create({
        data: {
          organizationId: org.id,
          action: 'export',
          entity: 'customer',
          entityId: customer.id,
          at: older,
        },
      });
      const a2 = await tx.auditLog.create({
        data: {
          organizationId: org.id,
          action: 'anonymize',
          entity: 'customer',
          entityId: customer.id,
          at: recent,
        },
      });
      plantedIds.push(a1.id, a2.id);
      return { org, customer };
    });
    orgId = seed.org.id;
    customerId = seed.customer.id;
  });

  afterAll(async () => {
    // audit_log is append-only in prod (spec §9.11). Escape hatch to
    // free the FK grip before hard-deleting the fixture org.
    const { resetAuditForOrgs } = await import('./helpers/audit-reset');
    await resetAuditForOrgs([orgId]);
    await withoutRls(async (tx) => {
      await tx.customer.delete({ where: { id: customerId } });
      await tx.organization.delete({ where: { id: orgId } });
    });
  });

  it('surfaces both export + anonymize rows, resolves customerName', async () => {
    const rows = await withOrg(orgId, (tx) => recentDsrActivity(tx, {}));
    const mine = rows.filter((r) => r.entityId === customerId);
    expect(mine.length).toBe(2);
    expect(mine.every((r) => r.customerName === 'DSR Target')).toBe(true);
    expect(new Set(mine.map((r) => r.action))).toEqual(new Set(['export', 'anonymize']));
  });

  it('flags the older row as overdue and the recent row as within SLA', async () => {
    const rows = await withOrg(orgId, (tx) => recentDsrActivity(tx, {}));
    const older = rows.find((r) => r.action === 'export' && r.entityId === customerId);
    const recent = rows.find((r) => r.action === 'anonymize' && r.entityId === customerId);
    expect(older?.slaOverdue).toBe(true);
    expect(recent?.slaOverdue).toBe(false);
  });

  it('dsrDeadlineDays honours env override', () => {
    const original = process.env.DSR_DEADLINE_DAYS;
    process.env.DSR_DEADLINE_DAYS = '7';
    expect(dsrDeadlineDays()).toBe(7);
    process.env.DSR_DEADLINE_DAYS = original ?? '';
    if (!original) delete process.env.DSR_DEADLINE_DAYS;
    expect(dsrDeadlineDays()).toBe(30);
  });
});
