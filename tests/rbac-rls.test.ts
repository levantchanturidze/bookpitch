import { describe, it, expect, beforeAll } from 'vitest';
import { prismaApp, prismaAdmin, withOrg, withoutRls } from '@/lib/db';

// -----------------------------------------------------------------------------
// Phase 3: RLS regression coverage on top of tests/rls.test.ts.
//
// tests/rls.test.ts already exercises the primary tenant-isolation path
// (customer visibility scoped to withOrg). This suite covers two more
// classes of concern the Phase 3 review flagged:
//
//   1. Every tenant table (any table with an organization_id column) has
//      RLS enabled. A missing policy would create a silent cross-tenant
//      leak that no application code could ever notice.
//   2. Cross-tenant INSERT via withOrg(A) writing organizationId=B is
//      blocked by WITH CHECK for additional tables (services, staff) —
//      rls.test.ts only covered customers.
// -----------------------------------------------------------------------------

describe('RLS coverage across every tenant table', () => {
  it('every table with an organization_id column has RLS enabled + forced', async () => {
    // Introspection: find every table with an organization_id column, then
    // check the RLS + FORCE bits on pg_class. A table that's in the list
    // but has relrowsecurity=false is a leak waiting to happen.
    const rows = await prismaAdmin.$queryRawUnsafe<Array<{
      table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>>(
      `SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND EXISTS (
                SELECT 1 FROM information_schema.columns col
                 WHERE col.table_schema = n.nspname
                   AND col.table_name = c.relname
                   AND col.column_name = 'organization_id'
              )
        ORDER BY c.relname`,
    );

    // Three categories of exemption:
    //   • audit_log partitions — the parent enforces RLS; partitions inherit.
    //   • roles / permissions / role_permissions — reference data, RLS-free
    //     by design (docs/rbac-schema-notes.md §3.2). Custom-role isolation
    //     is enforced at query time by the seed/admin writers.
    //   • impersonation_sessions / break_glass_sessions — platform-plane
    //     bookkeeping (Phase 5 §8). Queried only by lib/rbac/context.ts
    //     with prismaAdmin; not exposed to org-plane callers.
    // Any other table missing RLS is a defect.
    const EXEMPT_REFERENCE = new Set([
      'roles', 'permissions', 'role_permissions',
      'impersonation_sessions', 'break_glass_sessions',
    ]);
    const missing = rows.filter(r =>
      !/^audit_log_\d{4}_\d{2}$/.test(r.table_name)
      && r.table_name !== 'audit_log_default'
      && !EXEMPT_REFERENCE.has(r.table_name)
      && (!r.relrowsecurity || !r.relforcerowsecurity));
    expect(missing).toEqual([]);
  });
});

describe('cross-tenant INSERT is rejected by WITH CHECK', () => {
  let orgA: string;
  let orgB: string;
  let locA: string;

  beforeAll(async () => {
    const orgs = await withoutRls(tx =>
      tx.organization.findMany({ orderBy: { createdAt: 'asc' } }));
    orgA = orgs[0].id;
    orgB = orgs.find(o => o.name === 'Isolation Corp')!.id;
    const loc = await withoutRls(tx =>
      tx.location.findFirst({ where: { organizationId: orgA } }));
    locA = loc!.id;
  });

  it('services: withOrg(A) writing organizationId=B is rejected', async () => {
    await expect(
      withOrg(orgA, tx =>
        tx.service.create({
          data: {
            organizationId: orgB,          // sneaky
            locationId: locA,
            name: 'sneaky svc',
            price: 1,
            durationMinutes: 10,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('staff: withOrg(A) writing organizationId=B is rejected', async () => {
    await expect(
      withOrg(orgA, tx =>
        tx.staff.create({
          data: {
            organizationId: orgB,          // sneaky
            locationId: locA,
            name: 'sneaky staff',
            roleTitle: 'test',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('bypass attempts', () => {
  it('raw query via prismaApp with no org context returns zero rows', async () => {
    // Attacker angle: what if a Phase 4 refactor forgets withOrg and calls
    // prismaApp.$queryRaw directly? RLS policy predicate is NULL and
    // filters every row.
    const rows = await prismaApp.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM customers LIMIT 10`,
    );
    expect(rows.length).toBe(0);
  });

  it('raw query with an explicit WHERE organization_id still returns zero rows', async () => {
    // Even asking for a specific org id explicitly doesn't help — the RLS
    // policy is applied ON TOP OF the WHERE clause.
    const orgs = await withoutRls(tx => tx.organization.findMany({ take: 1 }));
    const rows = await prismaApp.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM customers WHERE organization_id = '${orgs[0].id}' LIMIT 10`,
    );
    expect(rows.length).toBe(0);
  });
});
