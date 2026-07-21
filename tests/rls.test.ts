import { describe, it, expect, beforeAll } from 'vitest';
import { prismaApp, withOrg, withoutRls } from '@/lib/db';

// Requires a seeded DB: primary org (5 customers) + "Isolation Corp" (1 customer).
describe('RLS tenant isolation', () => {
  let primaryOrgId: string;
  let isolationOrgId: string;

  beforeAll(async () => {
    const orgs = await withoutRls((tx) =>
      tx.organization.findMany({ orderBy: { createdAt: 'asc' } }),
    );
    expect(orgs.length).toBeGreaterThanOrEqual(2);
    primaryOrgId = orgs[0].id;
    isolationOrgId = orgs.find((o) => o.name === 'Isolation Corp')!.id;
  });

  it('lists only the primary org customers when scoped to primary', async () => {
    const customers = await withOrg(primaryOrgId, (tx) => tx.customer.findMany());
    expect(customers.length).toBe(5);
    expect(customers.every((c) => c.organizationId === primaryOrgId)).toBe(true);
  });

  it('lists only the isolation-org customer when scoped to isolation', async () => {
    const customers = await withOrg(isolationOrgId, (tx) => tx.customer.findMany());
    expect(customers.length).toBe(1);
    expect(customers[0].name).toBe('Do Not Leak');
    expect(customers[0].organizationId).toBe(isolationOrgId);
  });

  it('cannot INSERT a customer for a different org (WITH CHECK enforces on write)', async () => {
    await expect(
      withOrg(primaryOrgId, (tx) =>
        tx.customer.create({
          data: {
            organizationId: isolationOrgId, // sneaky cross-tenant write
            name: 'Should Be Rejected',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('app-role queries with no org context return zero rows (fail-closed)', async () => {
    // With RLS active on prismaApp and no `app.current_org_id` set, the policy
    // predicate evaluates to NULL → every row is filtered out. Defense in depth
    // against forgetting to call withOrg().
    const customers = await prismaApp.customer.findMany();
    expect(customers.length).toBe(0);
    const staff = await prismaApp.staff.findMany();
    expect(staff.length).toBe(0);
  });
});
