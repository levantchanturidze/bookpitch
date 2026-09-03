import { describe, it, expect } from 'vitest';
import { prismaApp, unsafePrismaAdmin } from '@/lib/db';

// -----------------------------------------------------------------------------
// Row-level security does not inherit downwards.
//
// `audit_log` is a partitioned parent with RLS enabled, FORCED, and a
// `tenant_isolation` policy. Every existing check verifies the PARENT — the
// production invariant script, tests/rbac-rls.test.ts, the restore drill.
//
// None of them ask the question that matters: what happens when the child is
// queried directly?
//
//     SELECT * FROM audit_log;            -- parent policy applies
//     SELECT * FROM audit_log_2026_09;    -- the child has its own relrowsecurity
//
// In Postgres, a partition does NOT inherit the parent's row-security when it
// is addressed by name. `relrowsecurity` on the child is what decides, and the
// migrations never set it — measured on production 2026-09-02:
//
//     audit_log_2026_09  SELECT=true INSERT=true rls=false force=false
//
// Measured as bookpitch_app with no organization context:
//
//     SELECT count(*) FROM audit_log         WHERE organization_id IS NOT NULL  ->     0
//     SELECT count(*) FROM audit_log_2026_09 WHERE organization_id IS NOT NULL  ->  1705
//     SELECT count(DISTINCT organization_id) FROM audit_log_2026_09             ->    15
//
// So the application role could read every organization's audit records by
// naming a partition, and write forged ones into it. tests/rbac-rls.test.ts
// explicitly EXEMPTS these tables with the comment "the parent enforces RLS;
// partitions inherit", which is the assumption this file exists to falsify.
//
// These probes run as the real application role (prismaApp, NOBYPASSRLS) with
// no organization context, which is the weakest possible position. Anything
// visible here is visible to any code path that forgets `withOrg`.
// -----------------------------------------------------------------------------

/** Partitions that currently exist, so the probes address real relations. */
async function auditPartitions(): Promise<string[]> {
  const rows = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ relname: string }>>(
    `SELECT c.relname
       FROM pg_inherits i
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_class c ON c.oid = i.inhrelid
      WHERE p.relname = 'audit_log'
        AND c.relname ~ '^audit_log_[0-9]{4}_[0-9]{2}$'
      ORDER BY c.relname`,
  );
  return rows.map((r) => r.relname);
}

describe('an audit partition addressed directly must not leak tenant rows', () => {
  it('the parent already refuses TENANT rows, with no org context', async () => {
    // The control. Scoped to organization_id IS NOT NULL on purpose: the
    // policy is `organization_id = current_org_id() OR organization_id IS
    // NULL`, so platform-plane rows with a null organization are visible to
    // everyone by design. Counting all rows would make this assert 0 against a
    // number that is legitimately non-zero (270 on the development database),
    // and the honest measurement is how many rows belonging to SOMEONE leak.
    const rows = await prismaApp.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM audit_log WHERE organization_id IS NOT NULL`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('THE BYPASS: every child partition refuses too', async () => {
    const partitions = await auditPartitions();
    expect(partitions.length, 'no partitions found — the probe would be vacuous').toBeGreaterThan(
      0,
    );

    const leaking: Array<{ partition: string; rows: number }> = [];
    for (const p of partitions) {
      const rows = await prismaApp
        .$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*)::bigint AS n FROM ${p} WHERE organization_id IS NOT NULL`,
        )
        .catch(() => null);
      // A permission error is a PASS: the role cannot reach the table at all.
      if (rows === null) continue;
      const n = Number(rows[0].n);
      if (n > 0) leaking.push({ partition: p, rows: n });
    }
    expect(leaking, 'audit rows are readable by naming a partition directly').toEqual([]);
  });

  it('the default partition refuses as well', async () => {
    const rows = await prismaApp
      .$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM audit_log_default WHERE organization_id IS NOT NULL`,
      )
      .catch(() => null);
    if (rows === null) return; // permission denied is fine
    expect(Number(rows[0].n)).toBe(0);
  });

  it('a forged audit row cannot be inserted into a partition directly', async () => {
    // The write side. The append-only trigger stops UPDATE and DELETE, but
    // nothing stopped an INSERT that names a partition and carries someone
    // else's organization_id — which would be a fabricated audit record
    // attributed to another tenant.
    const partitions = await auditPartitions();
    const target = partitions[partitions.length - 1];
    await expect(
      prismaApp.$executeRawUnsafe(
        `INSERT INTO ${target} (organization_id, action, entity, at)
         VALUES (gen_random_uuid(), 'rls.probe.forged', 'probe',
                 date_trunc('month', now()))`,
      ),
    ).rejects.toThrow();
  });

  it('every partition has row security enabled and forced in its own right', async () => {
    // The structural complement. The behavioural probes above pass trivially
    // on an empty table, so assert the mechanism as well as the effect.
    const rows = await unsafePrismaAdmin.$queryRawUnsafe<
      Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_inherits i
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_class c ON c.oid = i.inhrelid
        WHERE p.relname = 'audit_log'
        ORDER BY c.relname`,
    );
    const unprotected = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity);
    expect(
      unprotected.map((r) => r.relname),
      'partitions without their own RLS',
    ).toEqual([]);
  });

  it('a NEWLY created partition is protected automatically', async () => {
    // Repairing today's partitions is not enough: bp_create_monthly_partition()
    // runs monthly and would reintroduce the hole every time.
    const probeMonth = '2035-07-01';
    await unsafePrismaAdmin.$executeRawUnsafe(
      `SELECT bp_create_monthly_partition('audit_log'::regclass, '${probeMonth}'::date)`,
    );
    try {
      const rows = await unsafePrismaAdmin.$queryRawUnsafe<
        Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >(
        `SELECT relrowsecurity, relforcerowsecurity
           FROM pg_class WHERE relname = 'audit_log_2035_07'`,
      );
      expect(rows[0]?.relrowsecurity, 'new partition has no RLS').toBe(true);
      expect(rows[0]?.relforcerowsecurity, 'new partition does not FORCE RLS').toBe(true);
    } finally {
      await unsafePrismaAdmin.$executeRawUnsafe(
        `ALTER TABLE audit_log DETACH PARTITION audit_log_2035_07`,
      );
      await unsafePrismaAdmin.$executeRawUnsafe(`DROP TABLE IF EXISTS audit_log_2035_07`);
    }
  });
});
