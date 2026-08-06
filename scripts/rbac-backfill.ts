// -----------------------------------------------------------------------------
// RBAC Phase 2 backfill CLI.
//
//   npx tsx scripts/rbac-backfill.ts <subcommand>
//
// Subcommands:
//   dry-run   Report what the backfill would change. No writes.
//   apply     Run `prisma migrate deploy` for the Phase 2 migrations,
//             then verify. Non-zero exit on verify failure.
//   verify    Run invariant checks. Non-zero exit on any failure.
//   rollback  Apply both Phase 2 down.sql files (triggers first, then
//             backfill), then delete their _prisma_migrations rows.
//
// Uses DATABASE_URL_SUPERUSER_SESSION (superuser). If unset, falls back to
// legacy ADMIN_DATABASE_URL then DATABASE_URL_APP_NOBYPASSRLS / DATABASE_URL
// — but rollback needs DDL grants, so that fallback only works locally.
//
// Style matches prisma/rbac-seed.ts. All output is plain text (no colors)
// so it copy-pastes into the runbook / incident channel cleanly.
// -----------------------------------------------------------------------------

import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';

const BACKFILL_MIGRATION = '20260728000000_rbac_backfill';
const TRIGGERS_MIGRATION = '20260728000100_rbac_sync_triggers';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'prisma', 'migrations');

// -----------------------------------------------------------------------------
// pg client — used directly (not via Prisma) so we can execute multi-statement
// scripts (down.sql files contain DROP TRIGGER + DROP FUNCTION chains).
// -----------------------------------------------------------------------------
function connectionString(): string {
  const url =
    process.env.DATABASE_URL_SUPERUSER_SESSION ??
    process.env.DATABASE_URL_SUPERUSER_TXPOOL ??
    process.env.ADMIN_DATABASE_URL ??
    process.env.ADMIN_RUNTIME_DATABASE_URL ??
    process.env.DATABASE_URL_APP_NOBYPASSRLS ??
    process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'no database URL set — check DATABASE_URL_SUPERUSER_* or legacy ADMIN_DATABASE_URL / DATABASE_URL.',
    );
  }
  // pg refuses the `schema=public` query parameter that Prisma likes. Strip
  // it — search_path defaults to public anyway.
  return url.replace(/[?&]schema=[^&]*/g, '');
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// -----------------------------------------------------------------------------
// dry-run — count rows each backfill step WOULD change. Pure SELECTs.
// -----------------------------------------------------------------------------
async function dryRun(): Promise<void> {
  await withClient(async (c) => {
    const queries: Array<[label: string, sql: string]> = [
      [
        '1. organizations w/ vertical to fill',
        `
        SELECT count(DISTINCT o.id)::int AS n
          FROM organizations o
          JOIN locations l ON l.organization_id = o.id
         WHERE o.vertical IS NULL`,
      ],
      [
        '2. branches to create (one per unmirrored location)',
        `
        SELECT count(*)::int AS n
          FROM locations l
          LEFT JOIN branches b ON b.legacy_location_id = l.id
         WHERE b.id IS NULL`,
      ],
      [
        '3. organizations w/ owner_user_id to fill',
        `
        SELECT count(*)::int AS n
          FROM organizations o
         WHERE o.owner_user_id IS NULL
           AND EXISTS (SELECT 1 FROM memberships m
                        WHERE m.organization_id = o.id AND m.role = 'owner')`,
      ],
      [
        '4. memberships needing role_id (owner+practitioner+receptionist)',
        `
        SELECT count(*)::int AS n
          FROM memberships
         WHERE role_id IS NULL
           AND role IN ('owner','practitioner','receptionist')`,
      ],
      [
        '5. memberships needing joined_at',
        `
        SELECT count(*)::int AS n FROM memberships WHERE joined_at IS NULL`,
      ],
      [
        '6. memberships to flip is_bookable=true',
        `
        SELECT count(*)::int AS n FROM memberships
         WHERE role IN ('owner','practitioner') AND is_bookable = FALSE`,
      ],
      [
        '7. platform SUPER_ADMIN seed (levaaani@gmail.com)',
        `
        SELECT count(*)::int AS n FROM app_users
         WHERE email = 'levaaani@gmail.com' AND platform_role_id IS NULL`,
      ],
    ];

    console.log('=== Phase 2 backfill — dry run ===');
    for (const [label, sql] of queries) {
      const { rows } = await c.query<{ n: number }>(sql);
      console.log(`  ${String(rows[0]!.n).padStart(6)}  ${label}`);
    }
    console.log('');
    console.log('No writes performed. Run `apply` to execute.');
  });
}

// -----------------------------------------------------------------------------
// verify — spec Phase 2 invariant checks. Each returns { pass, detail }.
// -----------------------------------------------------------------------------
type Check = { name: string; sql: string; expectZero?: true };
const CHECKS: Check[] = [
  {
    name: 'A. every active app_user has ≥1 active membership OR is platform-plane',
    expectZero: true,
    sql: `
      SELECT count(*)::int AS n
        FROM app_users u
       WHERE u.status = 'active'
         AND u.platform_role_id IS NULL
         AND NOT EXISTS (
               SELECT 1 FROM memberships m
                WHERE m.user_id = u.id AND m.status = 'active'
             )`,
  },
  {
    name: 'B. every non-archived organization has owner_user_id set',
    expectZero: true,
    sql: `
      SELECT count(*)::int AS n FROM organizations
       WHERE status <> 'archived' AND owner_user_id IS NULL`,
  },
  {
    name: 'C. every non-archived organization has ≥1 active ORG_OWNER membership',
    expectZero: true,
    sql: `
      SELECT count(*)::int AS n FROM organizations o
       WHERE o.status <> 'archived'
         AND NOT EXISTS (
               SELECT 1 FROM memberships m
                 JOIN roles r ON r.id = m.role_id
                WHERE m.organization_id = o.id
                  AND m.status = 'active'
                  AND r.key = 'ORG_OWNER'
                  AND r.organization_id IS NULL
             )`,
  },
  {
    name: 'D. every location has exactly one branch (legacy_location_id 1:1)',
    expectZero: true,
    sql: `
      SELECT (
        (SELECT count(*) FROM locations)
        - (SELECT count(*) FROM branches WHERE legacy_location_id IS NOT NULL)
      )::int AS n`,
  },
  {
    name: 'E. no memberships with role set but role_id NULL',
    expectZero: true,
    sql: `
      SELECT count(*)::int AS n FROM memberships
       WHERE role IS NOT NULL AND role_id IS NULL`,
  },
  {
    name: 'F. enum→key mapping holds (owner=ORG_OWNER)',
    expectZero: true,
    sql: `
      SELECT abs(
        (SELECT count(*) FROM memberships WHERE role = 'owner')
        - (SELECT count(*) FROM memberships m JOIN roles r ON r.id = m.role_id
            WHERE r.key = 'ORG_OWNER' AND r.organization_id IS NULL)
      )::int AS n`,
  },
  {
    name: 'G. enum→key mapping holds (practitioner=PROVIDER)',
    expectZero: true,
    sql: `
      SELECT abs(
        (SELECT count(*) FROM memberships WHERE role = 'practitioner')
        - (SELECT count(*) FROM memberships m JOIN roles r ON r.id = m.role_id
            WHERE r.key = 'PROVIDER' AND r.organization_id IS NULL)
      )::int AS n`,
  },
  {
    name: 'H. enum→key mapping holds (receptionist=FRONT_DESK)',
    expectZero: true,
    sql: `
      SELECT abs(
        (SELECT count(*) FROM memberships WHERE role = 'receptionist')
        - (SELECT count(*) FROM memberships m JOIN roles r ON r.id = m.role_id
            WHERE r.key = 'FRONT_DESK' AND r.organization_id IS NULL)
      )::int AS n`,
  },
  {
    name: 'I. no is_bookable=true where role NOT IN (owner, practitioner)',
    expectZero: true,
    sql: `
      SELECT count(*)::int AS n FROM memberships
       WHERE is_bookable = TRUE
         AND role NOT IN ('owner','practitioner')`,
  },
  {
    name: 'J. no orphan branches (legacy_location_id points at deleted loc)',
    expectZero: true,
    sql: `
      SELECT count(*)::int AS n FROM branches b
       WHERE b.legacy_location_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = b.legacy_location_id)`,
  },
];

async function verify(): Promise<number> {
  return withClient(async (c) => {
    console.log('=== Phase 2 backfill — verify ===');
    let failures = 0;
    for (const check of CHECKS) {
      const { rows } = await c.query<{ n: number }>(check.sql);
      const n = rows[0]!.n;
      const pass = check.expectZero ? n === 0 : true;
      const mark = pass ? 'PASS' : 'FAIL';
      console.log(`  [${mark}] ${check.name}  (n=${n})`);
      if (!pass) failures++;
    }
    console.log('');
    if (failures === 0) {
      console.log('All checks passed.');
      return 0;
    }
    console.log(`${failures} check(s) FAILED — investigate before proceeding.`);
    return 1;
  });
}

// -----------------------------------------------------------------------------
// apply — runs `prisma migrate deploy` (which applies any pending migration,
// including Phase 2), then verify. Prints a summary of what happened.
// -----------------------------------------------------------------------------
async function apply(): Promise<number> {
  console.log('=== Phase 2 backfill — apply ===');
  console.log('$ npx prisma migrate deploy');
  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: process.env,
  });
  if (result.status !== 0) {
    console.error('prisma migrate deploy failed — aborting before verify.');
    return result.status ?? 1;
  }
  console.log('');
  return verify();
}

// -----------------------------------------------------------------------------
// rollback — run both down.sql files (triggers first, then backfill), then
// delete their rows from _prisma_migrations so `prisma migrate deploy` re-runs
// them cleanly on the next apply.
// -----------------------------------------------------------------------------
async function rollback(): Promise<void> {
  await withClient(async (c) => {
    console.log('=== Phase 2 backfill — rollback ===');
    // Order matters: drop triggers before rolling back the backfill so the
    // next writes don't immediately re-fill the columns we're clearing.
    for (const mig of [TRIGGERS_MIGRATION, BACKFILL_MIGRATION]) {
      const downPath = path.join(MIGRATIONS_DIR, mig, 'down.sql');
      console.log(`\n> ${mig}/down.sql`);
      const sql = readFileSync(downPath, 'utf8');
      await c.query(sql);
      await c.query('DELETE FROM _prisma_migrations WHERE migration_name = $1', [mig]);
      console.log('  applied, migration row removed');
    }
    console.log('\nRollback complete. Run `apply` to re-run the forward migration.');
  });
}

// -----------------------------------------------------------------------------
// Entrypoint
// -----------------------------------------------------------------------------
const CMDS = {
  'dry-run': async () => {
    await dryRun();
    return 0;
  },
  apply: async () => apply(),
  verify: async () => verify(),
  rollback: async () => {
    await rollback();
    return 0;
  },
} as const;

async function main() {
  const cmd = process.argv[2] as keyof typeof CMDS | undefined;
  if (!cmd || !(cmd in CMDS)) {
    console.error('usage: rbac-backfill.ts <dry-run|apply|verify|rollback>');
    process.exit(2);
  }
  const code = await CMDS[cmd]();
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
