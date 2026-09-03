import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// -----------------------------------------------------------------------------
// Injected-failure tests for scripts/verify-production-invariants.sql.
//
// tests/workflow-safety.test.ts already asserts things ABOUT this script: that
// it is read-only, that migrate.yml invokes it with `-f`. Those are text
// checks. They cannot tell you whether the script would actually notice a
// database that had lost its tenant isolation, and until now nothing could —
// the script had never been observed failing.
//
// It turned out not to notice. Two defects, both measured against production
// on 2026-09-01:
//
//   * The RLS check counted relations that already had relrowsecurity=true and
//     asserted the FORCE count matched. A required table that lost BOTH bits
//     left both counts, so `enabled = forced` still held and the check passed.
//   * It filtered `relkind = 'r'`. audit_log is `relkind = 'p'` — a partitioned
//     parent — so the table holding every tenant's audit records was never
//     examined. Production reported "20 tables with RLS, all 20 FORCED" while
//     the 21st went unchecked.
//
// CLAUDE.md § "Verify behaviour, not wiring": a control that does not change
// observable behaviour does not exist. So every invariant here is proven by
// breaking the database, watching the script exit non-zero with the right
// message, putting it back, and watching it pass again. A test that only
// asserted the happy path would be documentation that compiles.
//
// SAFETY. These tests MUTATE the database — they DISABLE row-level security,
// DETACH partitions and GRANT the app role rights it must never keep. Every
// one of them is gated on `assertDisposable()`, an ALLOW-list that accepts
// only loopback hosts and refuses a production-shaped database name. If no
// disposable database is configured the suite skips and says so out loud,
// rather than guessing.
// -----------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verify-production-invariants.sql');

// The migration/superuser role: these tests need to ALTER TABLE and DETACH
// PARTITION, which the app role deliberately cannot do.
//
// INVARIANT_TEST_DATABASE_URL wins, and the order matters. lib/db.ts builds
// `unsafePrismaAdmin` from DATABASE_URL_SUPERUSER_SESSION, so pointing that
// variable at a separate fixture database to isolate this suite silently
// splits the WHOLE run across two databases: prismaApp keeps using
// DATABASE_URL while every admin query goes somewhere else. Measured — 52 test
// files failed with "unknown customer" and similar, none of them for a real
// reason.
//
// So there is a dedicated variable for aiming this suite somewhere else, and
// the shared one is only a fallback. In CI they are the same database anyway:
// DATABASE_URL_SUPERUSER_SESSION is the CI superuser URL, this suite mutates
// and restores it in place, and vitest runs files serially.
const ADMIN_URL =
  process.env.INVARIANT_TEST_DATABASE_URL ?? process.env.DATABASE_URL_SUPERUSER_SESSION ?? '';

let pgEnv: NodeJS.ProcessEnv | null = null;
let tmpDir: string | null = null;

// Hosts that are throwaway by construction: the loopback interface of a
// developer machine or an ephemeral runner, and the service-container hostname
// on a GitHub Actions network. Same set as tests/setup.ts and
// scripts/assert-disposable-db.py.
const DISPOSABLE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);
const PRODUCTION_MARKERS = ['supabase', 'pooler', 'neon.tech', 'rds.amazonaws', 'azure', 'railway'];

/**
 * Refuse to run anywhere that could be production.
 *
 * scripts/assert-disposable-db.py is deliberately NOT reused here. It carries
 * one rule that is correct for a restore drill and wrong for this suite: it
 * refuses a target byte-identical to DATABASE_URL_SUPERUSER_SESSION, because a
 * drill must never restore over a database the application is configured to
 * use. This suite's target IS that database — the disposable CI one — so that
 * rule would reject every legitimate run, and loosening the shared script to
 * suit a test would weaken the drill.
 *
 * Everything that actually protects production is reproduced: an ALLOW-list of
 * loopback hosts (an unrecognised host fails), managed-provider markers as a
 * second line, and a refusal to touch a production-shaped database name.
 * Fails closed — anything unparseable is treated as not disposable.
 */
function assertDisposable(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  if (!DISPOSABLE_HOSTS.has(host)) return false;
  if (PRODUCTION_MARKERS.some((m) => host.includes(m))) return false;
  const db = decodeURIComponent(u.pathname.replace(/^\//, '')).toLowerCase();
  return !['postgres', 'prod', 'production', 'bookpitch'].includes(db);
}

/** libpq environment for a URL, with the password in a 0600 file, never argv. */
function buildPgEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bp-invariants-'));
  const pgpass = path.join(tmpDir, 'pgpass');
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  const host = u.hostname;
  const port = u.port || '5432';
  const db = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres';
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  writeFileSync(pgpass, `${esc(host)}:${port}:${esc(db)}:${esc(user)}:${esc(pass)}\n`, {
    mode: 0o600,
  });
  chmodSync(pgpass, 0o600);
  return {
    ...process.env,
    PGHOST: host,
    PGPORT: port,
    PGUSER: user,
    PGDATABASE: db,
    PGPASSFILE: pgpass,
    PGSSLMODE: 'disable',
    PGCONNECT_TIMEOUT: '15',
    // Partition bounds are timestamptz, and bp_create_monthly_partition casts
    // a date in the SESSION time zone. Creating them from a +04 session yields
    // months that start at 20:00 UTC the previous day, so four hours of every
    // month's audit rows route into the neighbouring partition. The verifier
    // treats that as a fault; CI runners are UTC, and pinning it here makes a
    // developer machine behave the same way instead of failing locally only.
    PGTZ: 'UTC',
  };
}

/** Run arbitrary SQL as the schema owner. Throws on error. */
function sql(statement: string): string {
  return execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-Atc', statement], {
    env: pgEnv!,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

type VerifyResult = { ok: boolean; output: string };

/**
 * Run the real production verifier exactly as migrate.yml does — `psql -f`.
 *
 * Returns rather than throws so a test can assert on the failure text.
 */
function runVerifier(): VerifyResult {
  try {
    const out = execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-f', SCRIPT], {
      env: pgEnv!,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  }
}

/**
 * The shape every injected-failure test takes.
 *
 * `break_` must make the verifier fail with a message matching `expect_`, and
 * `restore` must put it back well enough that the verifier passes again. The
 * final assertion is the one that makes this a test rather than a demo: if the
 * restore is incomplete the next case would inherit a broken fixture, and the
 * "passes again" assertion catches that immediately.
 */
function injects(name: string, breakSql: string[], expected: RegExp, restoreSql: string[]) {
  it(name, () => {
    expect(runVerifier().ok, 'fixture must be clean before injection').toBe(true);
    try {
      for (const s of breakSql) sql(s);
      const broken = runVerifier();
      expect(broken.ok, `verifier did NOT fail after: ${breakSql.join('; ')}`).toBe(false);
      expect(broken.output).toMatch(expected);
    } finally {
      for (const s of restoreSql) sql(s);
    }
    expect(runVerifier().ok, 'verifier must pass again once restored').toBe(true);
  });
}

const havePsql = (() => {
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const runnable = Boolean(ADMIN_URL) && havePsql && assertDisposable(ADMIN_URL);

describe.skipIf(!runnable)('production invariants fail against a broken database', () => {
  // Captured so a DROP can be undone exactly rather than approximately.
  let paymentsPolicy = '';
  let partitionFnDef = '';

  beforeAll(() => {
    pgEnv = buildPgEnv(ADMIN_URL);

    // Fixture: the verifier requires the current month and the next three
    // partitions, which is the horizon app/api/cron/db-partitions/route.ts
    // maintains. A CI database has only whatever the migrations created, so
    // roll it forward the same way the cron job does.
    for (let i = 0; i <= 3; i++) {
      sql(
        `SELECT bp_create_monthly_partition('audit_log'::regclass,` +
          ` (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '${i} months')::date);`,
      );
    }

    paymentsPolicy = sql(
      `SELECT 'CREATE POLICY tenant_isolation ON payments FOR ALL USING (' ||
              pg_get_expr(polqual, polrelid) || ') WITH CHECK (' ||
              pg_get_expr(polwithcheck, polrelid) || ')'
         FROM pg_policy WHERE polname='tenant_isolation'
          AND polrelid='public.payments'::regclass`,
    ).trim();

    partitionFnDef = sql(
      `SELECT pg_get_functiondef(p.oid) FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='bp_create_monthly_partition'`,
    ).trim();

    // Fail once, with the reason, rather than nineteen times with "fixture
    // must be clean". A database that does not already satisfy the production
    // invariants cannot host injected-failure tests: every case would fail for
    // a cause that has nothing to do with the injection. Seen on a developer
    // database carrying rolled-back migrations from an abandoned branch.
    const baseline = runVerifier();
    if (!baseline.ok) {
      throw new Error(
        'the target database does not satisfy the production invariants before any ' +
          'injection, so nothing below would be measuring what it claims. Point ' +
          'INVARIANT_TEST_DATABASE_URL at a freshly migrated database.\n\n' +
          baseline.output.trim(),
      );
    }
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes against the untouched fixture', () => {
    const r = runVerifier();
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/ALL CHECKS PASSED/);
  });

  // --- §4.1 row-level security -------------------------------------------
  //
  // The first case is the one the previous verifier could not see: dropping
  // BOTH bits removed the table from the enabled count and the forced count
  // together, so the equality it tested still held.
  describe('row-level security', () => {
    injects(
      'a required table that loses BOTH ENABLE and FORCE is caught',
      [
        'ALTER TABLE customers DISABLE ROW LEVEL SECURITY',
        'ALTER TABLE customers NO FORCE ROW LEVEL SECURITY',
      ],
      /customers \(RLS DISABLED and not forced\)/,
      [
        'ALTER TABLE customers ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE customers FORCE ROW LEVEL SECURITY',
      ],
    );

    injects(
      'a required table that loses FORCE alone is caught',
      ['ALTER TABLE appointments NO FORCE ROW LEVEL SECURITY'],
      /appointments \(not FORCED\)/,
      ['ALTER TABLE appointments FORCE ROW LEVEL SECURITY'],
    );

    // The regression test for the relkind='r' filter. audit_log is the only
    // partitioned tenant relation, so this case is the whole reason the
    // previous check reported 20 healthy tables out of 21.
    injects(
      'the PARTITIONED audit_log losing FORCE is caught (relkind=p regression)',
      ['ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY'],
      /audit_log \(not FORCED\)/,
      ['ALTER TABLE audit_log FORCE ROW LEVEL SECURITY'],
    );

    it('an expected tenant policy that is dropped is caught', () => {
      expect(runVerifier().ok).toBe(true);
      try {
        sql('DROP POLICY tenant_isolation ON payments');
        const broken = runVerifier();
        expect(broken.ok).toBe(false);
        expect(broken.output).toMatch(/payments has 0 permissive policies/);
      } finally {
        sql(paymentsPolicy);
      }
      expect(runVerifier().ok).toBe(true);
    });

    // A policy that still exists and still has the right name, but no longer
    // restricts anything. relrowsecurity stays true throughout.
    injects(
      'a tenant policy weakened to USING (true) is caught',
      ['ALTER POLICY tenant_isolation ON services USING (true)'],
      /services USING clause is .* but must be exactly/,
      ['ALTER POLICY tenant_isolation ON services USING (organization_id = current_org_id())'],
    );

    // WITH CHECK is what blocks a cross-tenant INSERT. Losing it leaves reads
    // isolated and writes wide open, which no read-side probe would notice.
    injects(
      'a tenant policy that loses its WITH CHECK is caught',
      ['ALTER POLICY tenant_isolation ON staff WITH CHECK (true)'],
      /staff WITH CHECK clause is .* but must be exactly/,
      ['ALTER POLICY tenant_isolation ON staff WITH CHECK (organization_id = current_org_id())'],
    );

    // The cases the old substring check could not see. Every one of these
    // mentions current_org_id() somewhere and isolates nothing.
    injects(
      'THE REGRESSION: a tautology that still mentions current_org_id() is caught',
      [
        'ALTER POLICY tenant_isolation ON services USING (organization_id = current_org_id() OR true)',
      ],
      /USING clause is .* but must be exactly/,
      ['ALTER POLICY tenant_isolation ON services USING (organization_id = current_org_id())'],
    );

    injects(
      'THE REGRESSION: an EXTRA permissive policy is caught',
      [
        // Postgres ORs permissive policies together, so this one overrides
        // tenant_isolation entirely while tenant_isolation still reads fine.
        'CREATE POLICY bp_fixture_bypass ON customers FOR ALL USING (true) WITH CHECK (true)',
      ],
      /permissive policies are ORed together/,
      ['DROP POLICY IF EXISTS bp_fixture_bypass ON customers'],
    );

    injects(
      'a policy narrowed to SELECT leaves writes unrestricted, and is caught',
      [
        'DROP POLICY IF EXISTS tenant_isolation ON waitlist',
        'CREATE POLICY tenant_isolation ON waitlist FOR SELECT USING (organization_id = current_org_id())',
      ],
      /is FOR .*, not FOR ALL — writes are unrestricted/,
      [
        'DROP POLICY IF EXISTS tenant_isolation ON waitlist',
        'CREATE POLICY tenant_isolation ON waitlist FOR ALL USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id())',
      ],
    );

    injects(
      'a policy scoped to a role the app does not use is caught',
      [
        'DROP POLICY IF EXISTS tenant_isolation ON notifications',
        'CREATE POLICY tenant_isolation ON notifications FOR ALL TO bookpitch_app USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id())',
      ],
      /applies to roles .* rather than PUBLIC/,
      [
        'DROP POLICY IF EXISTS tenant_isolation ON notifications',
        'CREATE POLICY tenant_isolation ON notifications FOR ALL USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id())',
      ],
    );

    injects(
      'a renamed policy is caught even when its predicate is correct',
      ['ALTER POLICY tenant_isolation ON message_log RENAME TO tenant_isolation_v2'],
      /is named tenant_isolation_v2, not tenant_isolation/,
      ['ALTER POLICY tenant_isolation_v2 ON message_log RENAME TO tenant_isolation'],
    );

    injects(
      'a required table missing from the schema entirely is caught',
      ['ALTER TABLE waitlist RENAME TO waitlist_absent_fixture'],
      /required tenant relation\(s\) absent: waitlist/,
      ['ALTER TABLE waitlist_absent_fixture RENAME TO waitlist'],
    );

    // A tenant table added by a later migration and never given RLS. The old
    // check could not see this at all: an unprotected table simply never
    // entered either count.
    injects(
      'a NEW organization_id table with no RLS is caught',
      ['CREATE TABLE bp_unclassified_fixture (id bigserial primary key, organization_id uuid)'],
      /neither RLS-protected nor a declared exemption: bp_unclassified_fixture/,
      ['DROP TABLE bp_unclassified_fixture'],
    );

    // Parked under a name matching the audit_log_YYYY_MM pattern, which check
    // 4d exempts, so that 4e is the check under test. Renaming it to anything
    // else makes 4d fire first — correctly, but on a different finding, and a
    // test that accepts either message proves neither.
    injects(
      'a declared exemption that no longer exists is caught',
      ['ALTER TABLE impersonation_sessions RENAME TO audit_log_1998_01'],
      /declared RLS exemption\(s\) no longer exist: impersonation_sessions/,
      ['ALTER TABLE audit_log_1998_01 RENAME TO impersonation_sessions'],
    );
  });

  // --- §4.4 audit_log partitioning ---------------------------------------
  describe('audit_log partitioning', () => {
    const cur = () =>
      sql(`SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'),'YYYY_MM')`).trim();
    const month = (i: number) =>
      sql(
        `SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC') + interval '${i} months','YYYY_MM')`,
      ).trim();
    const bounds = (i: number) => ({
      from: sql(
        `SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC') + interval '${i} months','YYYY-MM-DD')`,
      ).trim(),
      to: sql(
        `SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC') + interval '${i + 1} months','YYYY-MM-DD')`,
      ).trim(),
    });

    it('a missing CURRENT-month partition is caught', () => {
      const name = `audit_log_${cur()}`;
      const b = bounds(0);
      expect(runVerifier().ok).toBe(true);
      try {
        sql(`ALTER TABLE audit_log DETACH PARTITION ${name}`);
        const broken = runVerifier();
        expect(broken.ok).toBe(false);
        expect(broken.output).toMatch(new RegExp(`partition ${name} is missing or not attached`));
      } finally {
        sql(
          `ALTER TABLE audit_log ATTACH PARTITION ${name} FOR VALUES FROM ('${b.from}') TO ('${b.to}')`,
        );
      }
      expect(runVerifier().ok).toBe(true);
    });

    it('a missing FUTURE partition inside the maintenance horizon is caught', () => {
      const name = `audit_log_${month(3)}`;
      const b = bounds(3);
      expect(runVerifier().ok).toBe(true);
      try {
        sql(`ALTER TABLE audit_log DETACH PARTITION ${name}`);
        const broken = runVerifier();
        expect(broken.ok).toBe(false);
        expect(broken.output).toMatch(new RegExp(`partition ${name} is missing or not attached`));
      } finally {
        sql(
          `ALTER TABLE audit_log ATTACH PARTITION ${name} FOR VALUES FROM ('${b.from}') TO ('${b.to}')`,
        );
      }
      expect(runVerifier().ok).toBe(true);
    });

    // The exact state the previous check called healthy: plenty of
    // partitions, default empty, none of them covering today or later.
    it('a table with ONLY historical partitions is caught', () => {
      const names = [0, 1, 2, 3].map((i) => `audit_log_${month(i)}`);
      const bs = [0, 1, 2, 3].map((i) => bounds(i));
      expect(runVerifier().ok).toBe(true);
      try {
        for (const n of names) sql(`ALTER TABLE audit_log DETACH PARTITION ${n}`);
        const broken = runVerifier();
        expect(broken.ok).toBe(false);
        expect(broken.output).toMatch(/is missing or not attached/);
        // Historical partitions are still present and the default is still
        // empty — the two things the old check tested.
        expect(
          Number(sql(`SELECT count(*) FROM pg_inherits WHERE inhparent='audit_log'::regclass`)),
        ).toBeGreaterThan(0);
        expect(sql('SELECT count(*) FROM audit_log_default').trim()).toBe('0');
      } finally {
        names.forEach((n, i) =>
          sql(
            `ALTER TABLE audit_log ATTACH PARTITION ${n} FOR VALUES FROM ('${bs[i].from}') TO ('${bs[i].to}')`,
          ),
        );
      }
      expect(runVerifier().ok).toBe(true);
    });

    // A partition whose name claims one month and whose bounds cover another
    // routes writes into the wrong month silently.
    it('a partition whose bounds contradict its name is caught', () => {
      const PARK = 'audit_log_1999_01';
      const curName = `audit_log_${cur()}`;
      const nextName = `audit_log_${month(1)}`;
      const b0 = bounds(0);
      const b1 = bounds(1);
      expect(runVerifier().ok).toBe(true);
      try {
        sql(`ALTER TABLE audit_log DETACH PARTITION ${curName}`);
        sql(`ALTER TABLE audit_log DETACH PARTITION ${nextName}`);
        // Parked under a name that still matches the audit_log_YYYY_MM
        // pattern the verifier exempts. A name like `${curName}_orig` would
        // trip check 4d first — it carries organization_id and is in neither
        // the required nor the exempt set — and this test would then pass on
        // the wrong error.
        sql(`ALTER TABLE ${curName} RENAME TO ${PARK}`);
        // Same name as the current month, next month's bounds.
        sql(`CREATE TABLE ${curName} (LIKE audit_log INCLUDING ALL)`);
        sql(
          `ALTER TABLE audit_log ATTACH PARTITION ${curName} FOR VALUES FROM ('${b1.from}') TO ('${b1.to}')`,
        );
        // Secure the decoy exactly as migration 67 secures a real partition.
        // Without this, check 4f fires first — correctly, since an unsecured
        // partition IS a bypass — and this test would pass on the wrong error.
        sql(`REVOKE ALL ON ${curName} FROM bookpitch_app`);
        sql(`ALTER TABLE ${curName} ENABLE ROW LEVEL SECURITY`);
        sql(`ALTER TABLE ${curName} FORCE ROW LEVEL SECURITY`);
        sql(
          `CREATE POLICY tenant_isolation ON ${curName} FOR ALL ` +
            `USING (organization_id = current_org_id() OR organization_id IS NULL) ` +
            `WITH CHECK (organization_id = current_org_id() OR organization_id IS NULL)`,
        );
        const broken = runVerifier();
        expect(broken.ok).toBe(false);
        expect(broken.output).toMatch(/but its name claims/);
      } finally {
        sql(`ALTER TABLE audit_log DETACH PARTITION ${curName}`);
        sql(`DROP TABLE ${curName}`);
        sql(`ALTER TABLE ${PARK} RENAME TO ${curName}`);
        sql(
          `ALTER TABLE audit_log ATTACH PARTITION ${curName} FOR VALUES FROM ('${b0.from}') TO ('${b0.to}')`,
        );
        sql(
          `ALTER TABLE audit_log ATTACH PARTITION ${nextName} FOR VALUES FROM ('${b1.from}') TO ('${b1.to}')`,
        );
      }
      expect(runVerifier().ok).toBe(true);
    });

    it('a row that landed in the default partition is caught', () => {
      expect(runVerifier().ok).toBe(true);
      try {
        // Far outside every monthly partition, so routing sends it to default.
        sql(
          `INSERT INTO audit_log (action, entity, at)
           VALUES ('invariant.fixture', 'fixture', '2099-01-15T00:00:00Z')`,
        );
        const broken = runVerifier();
        expect(broken.ok).toBe(false);
        expect(broken.output).toMatch(/row\(s\) landed in audit_log_default/);
      } finally {
        // audit_log is append-only in the DATABASE, not in application code:
        // audit_log_block_mutation() refuses DELETE from every role including
        // the table owner (CLAUDE.md invariant 3). That is the guarantee
        // working, so the fixture has to step around it explicitly rather than
        // quietly having permission to undo it. Disabled on the default
        // partition only, and only for the length of this cleanup.
        sql('ALTER TABLE audit_log_default DISABLE TRIGGER USER');
        try {
          sql(`DELETE FROM audit_log_default WHERE action='invariant.fixture'`);
        } finally {
          sql('ALTER TABLE audit_log_default ENABLE TRIGGER USER');
        }
      }
      expect(runVerifier().ok).toBe(true);
    });

    it('a missing partition-maintenance function is caught', () => {
      expect(runVerifier().ok).toBe(true);
      try {
        sql('DROP FUNCTION bp_create_monthly_partition(regclass, date)');
        const broken = runVerifier();
        expect(broken.ok).toBe(false);
        expect(broken.output).toMatch(/bp_create_monthly_partition\(regclass, date\) is missing/);
      } finally {
        sql(partitionFnDef);
      }
      expect(runVerifier().ok).toBe(true);
    });
  });

  // --- §4.x the other invariants still fail when broken -------------------
  describe('the remaining invariants are not vacuous either', () => {
    injects(
      'restoring the MARKETING contact grant is caught',
      [
        `INSERT INTO role_permissions (role_id, permission_key)
         SELECT r.id, 'client.read:contact' FROM roles r
          WHERE r.key='MARKETING' AND r.organization_id IS NULL`,
      ],
      /MARKETING role still grants client\.read:contact/,
      [
        `DELETE FROM role_permissions rp USING roles r
          WHERE rp.role_id=r.id AND r.key='MARKETING' AND r.organization_id IS NULL
            AND rp.permission_key='client.read:contact'`,
      ],
    );

    injects(
      'granting the app role UPDATE on audit_log is caught',
      ['GRANT UPDATE ON public.audit_log TO bookpitch_app'],
      /bookpitch_app has UPDATE on audit_log/,
      ['REVOKE UPDATE ON public.audit_log FROM bookpitch_app'],
    );

    injects(
      'granting the app role BYPASSRLS is caught',
      ['ALTER ROLE bookpitch_app BYPASSRLS'],
      /bookpitch_app has BYPASSRLS/,
      ['ALTER ROLE bookpitch_app NOBYPASSRLS'],
    );
  });
});

// A guard on the guard: if the suite silently stops running, the injected
// failures above stop protecting anything and nothing would say so.
describe('injected-failure coverage is actually reachable', () => {
  it('reports why it is skipped rather than skipping silently', () => {
    if (runnable) {
      expect(runnable).toBe(true);
      return;
    }
    const reason = !ADMIN_URL
      ? 'no DATABASE_URL_SUPERUSER_SESSION / INVARIANT_TEST_DATABASE_URL'
      : !havePsql
        ? 'psql is not installed'
        : 'the configured database is not on the disposable allow-list';
    // Visible in the run output, so "0 injected-failure tests ran" is never
    // mistaken for "the invariants are proven".
    console.warn(`[production-invariants] injected-failure tests SKIPPED — ${reason}`);
    expect(reason).toBeTruthy();
  });
});
