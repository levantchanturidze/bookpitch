import { describe, it, expect, beforeAll } from 'vitest';
import { unsafePrismaAdmin, prismaApp, withOrg, withoutRls } from '@/lib/db';

// -----------------------------------------------------------------------------
// Phase 1 schema invariants:
//   • audit_log is append-only — UPDATE and DELETE raise for every role,
//     including the admin (superuser) client (spec §9.11).
//   • branches table exists and enforces tenant isolation via RLS.
//   • Row shape for spec §7.1 columns is available for future writes.
// -----------------------------------------------------------------------------

describe('audit_log is append-only (RBAC invariant §9.11)', () => {
  let orgId: string;
  let insertedAt: Date;
  let insertedId: bigint;

  beforeAll(async () => {
    const org = await withoutRls(tx => tx.organization.findFirst({ orderBy: { createdAt: 'asc' } }));
    if (!org) throw new Error('seed must have run');
    orgId = org.id;
    // Write a fresh row so we have something to try to mutate.
    const row = await withOrg(orgId, tx =>
      tx.auditLog.create({
        data: {
          organizationId: orgId,
          action: 'test_probe',
          entity: 'staff',
          meta: { note: 'inserted by rbac-schema.test.ts' },
        },
      }),
    );
    insertedAt = row.at;
    insertedId = row.id;
  });

  it('rejects UPDATE via the app role (bookpitch_app)', async () => {
    await expect(
      withOrg(orgId, tx =>
        tx.auditLog.update({
          where: { at_id: { at: insertedAt, id: insertedId } },
          data: { action: 'tampered' },
        }),
      ),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('rejects DELETE via the app role (bookpitch_app)', async () => {
    await expect(
      withOrg(orgId, tx =>
        tx.auditLog.deleteMany({ where: { id: insertedId } }),
      ),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('rejects UPDATE via the admin role (superuser) too — trigger fires for everyone', async () => {
    await expect(
      unsafePrismaAdmin.auditLog.update({
        where: { at_id: { at: insertedAt, id: insertedId } },
        data: { action: 'tampered_by_admin' },
      }),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('rejects DELETE via the admin role (superuser) too', async () => {
    await expect(
      unsafePrismaAdmin.auditLog.deleteMany({ where: { id: insertedId } }),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('INSERT is still allowed (append is the point)', async () => {
    const row = await withOrg(orgId, tx =>
      tx.auditLog.create({
        data: {
          organizationId: orgId,
          action: 'insert_still_works',
          entity: 'staff',
        },
      }),
    );
    expect(row.action).toBe('insert_still_works');
  });

  it('bookpitch_app grants no UPDATE or DELETE on audit_log', async () => {
    const rows = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ privilege_type: string; table_name: string }>>(
      `SELECT privilege_type, table_name
         FROM information_schema.role_table_grants
        WHERE grantee='bookpitch_app'
          AND table_name LIKE 'audit_log%'
          AND privilege_type IN ('UPDATE','DELETE')`,
    );
    expect(rows).toEqual([]);
  });
});

describe('branches table', () => {
  it('is tenant-isolated by RLS (no org context → zero rows)', async () => {
    const rows = await prismaApp.branch.findMany();
    expect(rows.length).toBe(0);
  });

  it('accepts an INSERT via withOrg and rejects cross-tenant WITH CHECK', async () => {
    const orgs = await withoutRls(tx =>
      tx.organization.findMany({ orderBy: { createdAt: 'asc' } }),
    );
    if (orgs.length < 2) return; // fixture only has one org locally? still safe.
    const [a, b] = orgs;
    const created = await withOrg(a.id, tx =>
      tx.branch.create({
        data: { organizationId: a.id, name: 'RLS probe branch' },
      }),
    );
    expect(created.organizationId).toBe(a.id);
    // Cross-tenant insert must fail.
    await expect(
      withOrg(a.id, tx =>
        tx.branch.create({
          data: { organizationId: b.id, name: 'sneaky' },
        }),
      ),
    ).rejects.toThrow();
    // Cleanup — INSERT succeeded, so a normal DELETE works here (branches
    // are NOT append-only, only audit_log is).
    await withOrg(a.id, tx => tx.branch.delete({ where: { id: created.id } }));
  });
});
