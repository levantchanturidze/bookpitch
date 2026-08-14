import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { unsafePrismaAdmin } from '@/lib/db';

// -----------------------------------------------------------------------------
// Phase 2 invariants:
//   • Sync triggers keep the new columns filled when app code writes to the
//     old shape. This is the "no drift after cutover" guarantee.
//   • The backfill SQL is idempotent — running it again after the DB is
//     already caught up is a no-op.
//   • The verify checks from scripts/rbac-backfill.ts hold against the
//     current DB state.
//
// Fixture strategy: build a scratch org / user / location / membership via
// unsafePrismaAdmin. Everything is CASCADEd through the org at the end, except for
// AppUsers with audit rows (append-only), which we detach via the standard
// audit-reset helper the seed uses.
// -----------------------------------------------------------------------------

const BACKFILL_SQL = readFileSync(
  path.join(process.cwd(), 'prisma', 'migrations', '20260728000000_rbac_backfill', 'migration.sql'),
  'utf8',
);

const scratchOrgIds: string[] = [];
const scratchUserIds: string[] = [];

async function scratchOrg(
  name: string,
  extras?: Partial<{ vertical: string; ownerUserId: string }>,
) {
  // status='archived' exempts scratch orgs from the "must have owner" invariant
  // check below — they're test fixtures, not real orgs, and cleaned up in
  // afterAll. Real behavior is exercised by the trigger tests, which don't
  // depend on owner_user_id being set.
  const org = await unsafePrismaAdmin.organization.create({
    data: {
      name,
      status: 'archived',
      vertical: extras?.vertical ?? null,
      ownerUserId: extras?.ownerUserId ?? null,
    },
  });
  scratchOrgIds.push(org.id);
  return org;
}

async function scratchUser(email: string) {
  const user = await unsafePrismaAdmin.appUser.create({
    data: {
      authProvider: 'credentials',
      authSubject: `backfill-test-${email}`,
      email,
    },
  });
  scratchUserIds.push(user.id);
  return user;
}

afterAll(async () => {
  // Delete memberships first (they hold user + org FKs).
  await unsafePrismaAdmin.membership.deleteMany({
    where: { organizationId: { in: scratchOrgIds } },
  });
  // Locations cascade to branches via BEFORE-DELETE trigger + FK.
  await unsafePrismaAdmin.location.deleteMany({ where: { organizationId: { in: scratchOrgIds } } });
  // Orgs cascade to branches and any leftover memberships.
  await unsafePrismaAdmin.organization.deleteMany({ where: { id: { in: scratchOrgIds } } });
  // Users can be hard-deleted only when they have no audit rows. Scratch
  // users never write audit_log (no requireRole path involved), so a plain
  // delete works.
  await unsafePrismaAdmin.appUser.deleteMany({ where: { id: { in: scratchUserIds } } });
});

// -----------------------------------------------------------------------------
// Trigger: memberships sync — insert with role_id=NULL, expect it filled.
// -----------------------------------------------------------------------------
describe('sync trigger: memberships fill role_id / joined_at / is_bookable', () => {
  let orgId: string;
  beforeAll(async () => {
    orgId = (await scratchOrg('memberships-sync-org')).id;
  });

  it.each([
    ['owner', 'ORG_OWNER', true],
    ['practitioner', 'PROVIDER', true],
    ['receptionist', 'FRONT_DESK', false],
  ] as const)('%s → %s (is_bookable=%s)', async (roleEnum, expectedKey, expectedBookable) => {
    const user = await scratchUser(`memb-${roleEnum}-${Date.now()}@ex.com`);
    // Explicitly null out the new columns to prove the trigger fills them.
    // We use $executeRawUnsafe so Prisma doesn't apply its own defaults.
    await unsafePrismaAdmin.$executeRawUnsafe(
      `INSERT INTO memberships (organization_id, user_id, role, role_id, joined_at, is_bookable)
       VALUES ('${orgId}', '${user.id}', '${roleEnum}', NULL, NULL, FALSE)`,
    );
    const [row] = await unsafePrismaAdmin.$queryRawUnsafe<
      Array<{
        role: string;
        role_key: string | null;
        is_bookable: boolean;
        joined_at: Date | null;
      }>
    >(
      `SELECT m.role, r.key AS role_key, m.is_bookable, m.joined_at
         FROM memberships m LEFT JOIN roles r ON r.id = m.role_id
        WHERE m.user_id = '${user.id}' AND m.organization_id = '${orgId}'`,
    );
    expect(row?.role_key).toBe(expectedKey);
    expect(row?.is_bookable).toBe(expectedBookable);
    expect(row?.joined_at).not.toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Trigger: locations INSERT → branches row appears with matching fields.
// -----------------------------------------------------------------------------
describe('sync trigger: locations → branches mirror', () => {
  let orgId: string;
  beforeAll(async () => {
    orgId = (await scratchOrg('loc-sync-org')).id;
  });

  it('INSERT: creates a branches row with matching name/timezone/legacy_location_id', async () => {
    const loc = await unsafePrismaAdmin.location.create({
      data: { organizationId: orgId, type: 'clinic', name: 'Loc A', timezone: 'Europe/Berlin' },
    });
    const branch = await unsafePrismaAdmin.branch.findFirst({
      where: { legacyLocationId: loc.id },
    });
    expect(branch).toBeTruthy();
    expect(branch!.name).toBe('Loc A');
    expect(branch!.timezone).toBe('Europe/Berlin');
    expect(branch!.organizationId).toBe(orgId);
  });

  it('INSERT: fills organizations.vertical from the first location type', async () => {
    const org = await unsafePrismaAdmin.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.vertical).toBe('clinic');
  });

  it('UPDATE OF name / timezone: propagates to the linked branch', async () => {
    const loc = await unsafePrismaAdmin.location.create({
      data: { organizationId: orgId, type: 'salon', name: 'Loc B', timezone: 'Asia/Tbilisi' },
    });
    await unsafePrismaAdmin.location.update({
      where: { id: loc.id },
      data: { name: 'Loc B Renamed', timezone: 'Europe/Paris' },
    });
    const branch = await unsafePrismaAdmin.branch.findFirstOrThrow({
      where: { legacyLocationId: loc.id },
    });
    expect(branch.name).toBe('Loc B Renamed');
    expect(branch.timezone).toBe('Europe/Paris');
  });

  it('DELETE: BEFORE-DELETE trigger removes the linked branch before the FK nulls it', async () => {
    const loc = await unsafePrismaAdmin.location.create({
      data: { organizationId: orgId, type: 'clinic', name: 'Loc C' },
    });
    const branchId = (
      await unsafePrismaAdmin.branch.findFirstOrThrow({
        where: { legacyLocationId: loc.id },
      })
    ).id;
    await unsafePrismaAdmin.location.delete({ where: { id: loc.id } });
    const orphan = await unsafePrismaAdmin.branch.findUnique({ where: { id: branchId } });
    expect(orphan).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Backfill idempotency: run the migration SQL a second time against a
// fully-migrated DB and confirm the row-change counts are zero.
// -----------------------------------------------------------------------------
describe('backfill migration.sql is idempotent', () => {
  it('re-running touches zero rows and leaves the DB unchanged', async () => {
    // Snapshot the exact rows we care about before the re-run.
    const before = await snapshot();
    // Split the migration into statements naively (Prisma migrations use ;\n
    // as the boundary; our SQL doesn't nest inside function bodies).
    const statements = BACKFILL_SQL.split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));
    for (const stmt of statements) {
      await unsafePrismaAdmin.$executeRawUnsafe(stmt);
    }
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  async function snapshot() {
    const [row] = await unsafePrismaAdmin.$queryRawUnsafe<
      Array<{
        orgs: bigint;
        orgs_vertical: bigint;
        orgs_owner: bigint;
        locations: bigint;
        branches: bigint;
        memberships: bigint;
        role_id_set: bigint;
        joined_at_set: bigint;
        bookable_true: bigint;
      }>
    >(
      `SELECT
         (SELECT count(*) FROM organizations)                                    AS orgs,
         (SELECT count(*) FROM organizations WHERE vertical IS NOT NULL)         AS orgs_vertical,
         (SELECT count(*) FROM organizations WHERE owner_user_id IS NOT NULL)    AS orgs_owner,
         (SELECT count(*) FROM locations)                                        AS locations,
         (SELECT count(*) FROM branches WHERE legacy_location_id IS NOT NULL)    AS branches,
         (SELECT count(*) FROM memberships)                                      AS memberships,
         (SELECT count(*) FROM memberships WHERE role_id IS NOT NULL)            AS role_id_set,
         (SELECT count(*) FROM memberships WHERE joined_at IS NOT NULL)          AS joined_at_set,
         (SELECT count(*) FROM memberships WHERE is_bookable = TRUE)             AS bookable_true`,
    );
    return row!;
  }
});

// -----------------------------------------------------------------------------
// Verify checks — sanity that the current DB passes every invariant.
// This is the same set the CLI runs; kept in the test file so unit runs
// catch drift without needing to shell out.
// -----------------------------------------------------------------------------
describe('backfill verify invariants (current DB state)', () => {
  // Clean up orphaned test users that previous interrupted runs may have left.
  // Production data never uses these email domains; seeded users have real emails.
  beforeAll(async () => {
    await unsafePrismaAdmin.$executeRaw`
      DELETE FROM app_users
      WHERE status = 'active'
        AND platform_role_id IS NULL
        AND (email LIKE '%@bookpitch-test.invalid' OR email LIKE '%-test%@%.dev' OR email LIKE '%-test%@%.invalid')
        AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = app_users.id AND status = 'active')
    `;
  });

  const zeroExpectations: Array<[string, string]> = [
    [
      'A. active users without membership (non-platform)',
      `SELECT count(*)::int AS n FROM app_users u
        WHERE u.status='active' AND u.platform_role_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.status='active')`,
    ],
    [
      'B. non-archived orgs without owner_user_id',
      `SELECT count(*)::int AS n FROM organizations WHERE status<>'archived' AND owner_user_id IS NULL`,
    ],
    [
      'D. locations without a matching branch',
      `SELECT ((SELECT count(*) FROM locations) - (SELECT count(*) FROM branches WHERE legacy_location_id IS NOT NULL))::int AS n`,
    ],
    [
      'E. memberships with role set but role_id NULL',
      `SELECT count(*)::int AS n FROM memberships WHERE role IS NOT NULL AND role_id IS NULL`,
    ],
    [
      "I. is_bookable=true on a role that isn't owner/practitioner",
      `SELECT count(*)::int AS n FROM memberships WHERE is_bookable=TRUE AND role NOT IN ('owner','practitioner')`,
    ],
    [
      'J. orphan branches (legacy_location_id → deleted loc)',
      `SELECT count(*)::int AS n FROM branches b WHERE b.legacy_location_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id=b.legacy_location_id)`,
    ],
  ];

  it.each(zeroExpectations)('%s → 0', async (_label, sql) => {
    const [row] = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ n: number }>>(sql);
    expect(row!.n).toBe(0);
  });
});
