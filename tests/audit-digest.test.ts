import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { buildDigest, renderDigestText } = await import('@/lib/audit-digest');

describe('audit digest builder', () => {
  let orgId: string;
  let customerId: string;
  let actorId: string;
  const plantedIds: bigint[] = [];

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `digest-${Date.now()}` } });
      const customer = await tx.customer.create({
        data: { organizationId: org.id, name: 'D Target' },
      });
      const actor = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `digest-${Date.now()}@ex.dev`,
          email: `digest-${Date.now()}@ex.dev`,
          fullName: 'Digest Actor',
          passwordHash: 'x',
        },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: actor.id, role: 'owner' },
      });
      // Invariant B: non-archived orgs must have owner_user_id set (spec §5).
      await tx.organization.update({
        where: { id: org.id },
        data: { ownerUserId: actor.id },
      });
      const inWindow = new Date();
      const outOfWindow = new Date(Date.now() - 40 * 24 * 3600 * 1000);
      const mk = async (action: string, at: Date) =>
        (
          await tx.auditLog.create({
            data: {
              organizationId: org.id,
              actorUserId: actor.id,
              action,
              entity: 'customer',
              entityId: customer.id,
              at,
            },
          })
        ).id;
      plantedIds.push(
        await mk('create', inWindow),
        await mk('update', inWindow),
        await mk('list', inWindow),
        await mk('export', inWindow),
        await mk('anonymize', inWindow),
        await mk('create', outOfWindow),
      );
      return { org, customer, actor };
    });
    orgId = seed.org.id;
    customerId = seed.customer.id;
    actorId = seed.actor.id;
  });

  afterAll(async () => {
    // audit_log is append-only in prod (spec §9.11). This test's
    // fixtures include audit rows that pin the fixture org + user via
    // NO ACTION FK; wipe them via the dev-only escape hatch first.
    const { resetAuditForOrgs } = await import('./helpers/audit-reset');
    await resetAuditForOrgs([orgId]);
    await withoutRls(async (tx) => {
      await tx.membership.deleteMany({ where: { organizationId: orgId } });
      await tx.appUser.delete({ where: { id: actorId } });
      await tx.customer.delete({ where: { id: customerId } });
      await tx.organization.delete({ where: { id: orgId } });
    });
  });

  it('counts by category over the 7-day window and excludes older rows', async () => {
    const d = await buildDigest(orgId);
    expect(d.counts.exports).toBe(1);
    expect(d.counts.anonymizes).toBe(1);
    expect(d.counts.customerReads).toBe(1);
    expect(d.counts.customerWrites).toBe(2);
    expect(d.counts.total).toBe(5);
    expect(d.topActors[0]?.count).toBe(5);
  });

  it('render omits patient ids/names — only counts + actor emails', async () => {
    const d = await buildDigest(orgId);
    const text = renderDigestText(d);
    expect(text).not.toContain('D Target'); // customer name
    expect(text).not.toContain(customerId);
    expect(text).toContain('Exports:');
    expect(text).toContain('Weekly audit digest');
  });
});
