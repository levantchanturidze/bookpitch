import { describe, it, expect } from 'vitest';

// Verify bookpitch_login and bookpitch_app role attributes and grants on the
// local development database (never production).
//
// bookpitch_login — SEC-007: narrow auth-graph role
//   • LOGIN + BYPASSRLS + NOSUPERUSER
//   • SELECT on ~8 auth tables only
//   • No grants on sensitive tables (customers, audit_log, etc.)
//
// bookpitch_app — runtime NOBYPASSRLS role
//   • LOGIN + NOBYPASSRLS + NOSUPERUSER
//   • Full DML on tenant tables

const { unsafePrismaAdmin } = await import('@/lib/db');

type PgRole = {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
  rolinherit: boolean;
};

type TableGrant = {
  table_name: string;
  privilege_type: string;
};

describe('bookpitch_login role attributes (SEC-007)', () => {
  it('exists with LOGIN + BYPASSRLS + NOSUPERUSER', async () => {
    const rows = await unsafePrismaAdmin.$queryRaw<PgRole[]>`
      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit
      FROM pg_roles
      WHERE rolname = 'bookpitch_login'
    `;
    expect(rows).toHaveLength(1);
    const role = rows[0];
    expect(role.rolcanlogin).toBe(true);
    expect(role.rolbypassrls).toBe(true);
    expect(role.rolsuper).toBe(false);
  });

  const EXPECTED_GRANTS = [
    'app_users',
    'memberships',
    'organizations',
    'roles',
    'role_permissions',
    'membership_branches',
    'impersonation_sessions',
    'break_glass_sessions',
  ];

  it.each(EXPECTED_GRANTS)('has SELECT grant on %s', async (tableName) => {
    const rows = await unsafePrismaAdmin.$queryRaw<TableGrant[]>`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'bookpitch_login'
        AND table_schema = 'public'
        AND table_name = ${tableName}
        AND privilege_type = 'SELECT'
    `;
    expect(rows.length).toBeGreaterThan(0);
  });

  const FORBIDDEN_TABLES = [
    'customers',
    'audit_log',
    'appointments',
    'clinical_notes',
    'payments',
    'waitlist',
    'platform_reauth_grants',
    'platform_rate_limits',
  ];

  it.each(FORBIDDEN_TABLES)('has NO grants on sensitive table %s', async (tableName) => {
    const rows = await unsafePrismaAdmin.$queryRaw<TableGrant[]>`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'bookpitch_login'
        AND table_schema = 'public'
        AND table_name = ${tableName}
    `;
    expect(rows).toHaveLength(0);
  });
});

describe('bookpitch_app role attributes (runtime NOBYPASSRLS role)', () => {
  it('exists with LOGIN + NOBYPASSRLS + NOSUPERUSER', async () => {
    const rows = await unsafePrismaAdmin.$queryRaw<PgRole[]>`
      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
      FROM pg_roles
      WHERE rolname = 'bookpitch_app'
    `;
    expect(rows).toHaveLength(1);
    const role = rows[0];
    expect(role.rolcanlogin).toBe(true);
    expect(role.rolbypassrls).toBe(false);
    expect(role.rolsuper).toBe(false);
  });

  it('has DML grants on tenant tables (customers, memberships, organizations)', async () => {
    const tables = ['customers', 'memberships', 'organizations'];
    for (const tableName of tables) {
      const rows = await unsafePrismaAdmin.$queryRaw<TableGrant[]>`
        SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
        WHERE grantee = 'bookpitch_app'
          AND table_schema = 'public'
          AND table_name = ${tableName}
          AND privilege_type = 'SELECT'
      `;
      expect(rows.length).toBeGreaterThan(0);
    }
  });
});
