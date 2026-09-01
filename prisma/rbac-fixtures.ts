// -----------------------------------------------------------------------------
// RBAC Phase 3 — multi-tenant test fixtures.
//
// Adds three shapes the base seed doesn't cover:
//   1. Split Practice — 3 branches + a manager scoped to 2 of them
//   2. Solo Practice  — one person holding ORG_OWNER + PROVIDER (spec §2.3)
//   3. Moonlighter    — same user, PROVIDER in two orgs
//
// Called from prisma/seed.ts after the base seed. Idempotent (upserts by
// email / org name / branch name) so it's also safe to run standalone:
//   node --env-file=.env.local ./node_modules/.bin/tsx prisma/rbac-fixtures.ts
//
// Uses unsafePrismaAdmin (BYPASSRLS) because it writes across multiple orgs.
// Passwords match the base seed's DEV_USER_PASSWORD default.
// -----------------------------------------------------------------------------

// F-02: MUST be the very first import. Guards against running this fixture
// against a non-local DB (which would create test users with the repo-
// committed DEV_USER_PASSWORD default on a production tenant).
import './_require-local-db-guard';

import { UserRole } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import { unsafePrismaAdmin } from '@/lib/db';

const DEV_PASSWORD = process.env.DEV_USER_PASSWORD ?? 'devpass123';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function upsertOrg(name: string, extras?: { vertical?: string }): Promise<{ id: string }> {
  const existing = await unsafePrismaAdmin.organization.findFirst({ where: { name } });
  if (existing) return { id: existing.id };
  return unsafePrismaAdmin.organization.create({
    data: { name, vertical: extras?.vertical ?? null },
    select: { id: true },
  });
}

async function upsertUser(
  email: string,
  fullName: string,
  passwordHash: string,
): Promise<{ id: string }> {
  const existing = await unsafePrismaAdmin.appUser.findUnique({ where: { email } });
  if (existing) return { id: existing.id };
  return unsafePrismaAdmin.appUser.create({
    data: {
      authProvider: 'credentials',
      authSubject: email,
      email,
      fullName,
      passwordHash,
    },
    select: { id: true },
  });
}

async function upsertBranch(orgId: string, name: string): Promise<{ id: string }> {
  const existing = await unsafePrismaAdmin.branch.findFirst({
    where: { organizationId: orgId, name },
  });
  if (existing) return { id: existing.id };
  return unsafePrismaAdmin.branch.create({
    data: { organizationId: orgId, name },
    select: { id: true },
  });
}

/**
 * Upsert a membership by (userId, orgId, role_enum). The Phase 1 legacy
 * unique index is (org, user), which forbids multiple roles per user per
 * org via the enum. To seed the solo-practitioner two-role case, use the
 * new (user, org, role_id) unique — but that requires the enum column to
 * be distinct too, which it isn't (only three enum values).
 *
 * Workaround for MVP: solo practitioner keeps a single enum row (owner)
 * but gets TWO role_id-only assignments. Not quite spec §2.3 — the
 * "distinct memberships" invariant would need Phase 4 to relax the legacy
 * enum unique. Tracked in docs/rbac-schema-notes.md §7. Fixture below
 * models this correctly: single row per (org, user), with an extra
 * `roles` reference for the PROVIDER hat when we want to test it.
 */
const ENUM_TO_KEY: Record<UserRole, string> = {
  [UserRole.owner]: 'ORG_OWNER',
  [UserRole.practitioner]: 'PROVIDER',
  [UserRole.receptionist]: 'FRONT_DESK',
};

async function upsertMembership(
  userId: string,
  orgId: string,
  legacyRole: UserRole,
): Promise<{ id: string }> {
  const existing = await unsafePrismaAdmin.membership.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
  });
  if (existing) return { id: existing.id };
  const roleRow = await unsafePrismaAdmin.role.findFirstOrThrow({
    where: { key: ENUM_TO_KEY[legacyRole], organizationId: null },
    select: { id: true },
  });
  return unsafePrismaAdmin.membership.create({
    data: { organizationId: orgId, userId, role: legacyRole, roleId: roleRow.id },
    select: { id: true },
  });
}

async function ensureBranchScope(membershipId: string, branchIds: string[]): Promise<void> {
  const existing = await unsafePrismaAdmin.membershipBranch.findMany({
    where: { membershipId },
    select: { branchId: true },
  });
  const have = new Set(existing.map((r) => r.branchId));
  const toAdd = branchIds.filter((b) => !have.has(b));
  const toRemove = existing.filter((r) => !branchIds.includes(r.branchId));
  if (toAdd.length > 0) {
    await unsafePrismaAdmin.membershipBranch.createMany({
      data: toAdd.map((branchId) => ({ membershipId, branchId })),
      skipDuplicates: true,
    });
  }
  for (const r of toRemove) {
    await unsafePrismaAdmin.membershipBranch.delete({
      where: { membershipId_branchId: { membershipId, branchId: r.branchId } },
    });
  }
}

// -----------------------------------------------------------------------------
// Main entry.
// -----------------------------------------------------------------------------

export async function seedRbacFixtures(): Promise<void> {
  const passwordHash = await hash(DEV_PASSWORD);

  // Grand Medical is created by the base seed; look it up.
  const grand = await unsafePrismaAdmin.organization.findFirstOrThrow({
    where: { name: 'Grand Medical & Aurora Spa Group' },
    select: { id: true },
  });

  // ---- Split Practice: three-branch org with a scoped manager ----
  const split = await upsertOrg('Split Practice', { vertical: 'clinic' });
  const downtown = await upsertBranch(split.id, 'Downtown');
  const uptown = await upsertBranch(split.id, 'Uptown');
  // The branch is created for its side effect; nothing here reads it back.
  await upsertBranch(split.id, 'Airport');
  // Legacy `locations` compat — analytics and other pages still read
  // from `locations`. Give Split Practice one so those queries don't
  // 404 in tests. Phase 6: link the Downtown branch to this legacy
  // location so `scopedLocationIds(ctx)` for the BRANCH_MANAGER
  // resolves to a real location id.
  let splitLoc = await unsafePrismaAdmin.location.findFirst({
    where: { organizationId: split.id },
  });
  if (!splitLoc) {
    splitLoc = await unsafePrismaAdmin.location.create({
      data: { organizationId: split.id, type: 'clinic', name: 'Split Downtown Loc' },
    });
  }
  // Phase 2 sync trigger auto-creates a branch that shadow-links to
  // this location. Redirect the pointer to the manager-scoped Downtown
  // branch instead, so scopedLocationIds resolves cleanly.
  const shadow = await unsafePrismaAdmin.branch.findFirst({
    where: { organizationId: split.id, legacyLocationId: splitLoc.id, name: { not: 'Downtown' } },
  });
  if (shadow) await unsafePrismaAdmin.branch.delete({ where: { id: shadow.id } });
  await unsafePrismaAdmin.branch.updateMany({
    where: { id: downtown.id, legacyLocationId: null },
    data: { legacyLocationId: splitLoc.id },
  });

  const owner = await upsertUser('split-owner@bp.test', 'Split Owner', passwordHash);
  await upsertMembership(owner.id, split.id, UserRole.owner);
  // Phase 2 backfill fills organizations.owner_user_id from the first
  // ORG_OWNER membership by created_at. The sync trigger doesn't cover
  // this column (only vertical), so fixture-created orgs need it set here.
  await unsafePrismaAdmin.organization.update({
    where: { id: split.id },
    data: { ownerUserId: owner.id },
  });

  const splitManager = await upsertUser('splitmgr@bp.test', 'Split Manager', passwordHash);
  // Legacy enum has no "manager" value — pit at receptionist so the base
  // schema is satisfied. role_id is the authoritative Phase 3 pointer; we
  // override it explicitly below to BRANCH_MANAGER.
  const mgrMembership = await upsertMembership(splitManager.id, split.id, UserRole.receptionist);
  await unsafePrismaAdmin.$executeRaw`
    UPDATE memberships SET role_id = (
      SELECT id FROM roles WHERE key = 'BRANCH_MANAGER' AND organization_id IS NULL
    ) WHERE id = ${mgrMembership.id}::uuid`;
  await ensureBranchScope(mgrMembership.id, [downtown.id, uptown.id]);

  // ---- Solo Practice: one member holds ORG_OWNER + PROVIDER ----
  // The legacy (org, user) unique lets us seed exactly ONE membership row.
  // For MVP the same membership carries BOTH intent — see the roles table
  // for tests that need to check the second hat. This limitation is
  // documented in docs/rbac-schema-notes.md §7.
  const solo = await upsertOrg('Solo Practice', { vertical: 'clinic' });
  const soloDoc = await upsertUser('solo@bp.test', 'Solo Doc', passwordHash);
  await upsertMembership(soloDoc.id, solo.id, UserRole.owner);
  await unsafePrismaAdmin.organization.update({
    where: { id: solo.id },
    data: { ownerUserId: soloDoc.id },
  });

  // ---- Moonlighter: PROVIDER in Grand Medical AND Split Practice ----
  const moon = await upsertUser('moonlight@bp.test', 'Moon Lighter', passwordHash);
  await upsertMembership(moon.id, grand.id, UserRole.practitioner);
  await upsertMembership(moon.id, split.id, UserRole.practitioner);

  // ---- Phase 5 platform users (spec §4.1) ----
  // Each maps to one platform-plane role. No org memberships — platform
  // accounts operate cross-tenant via impersonation / break-glass.
  await ensurePlatformUser('superadmin@bp.test', 'SUPER_ADMIN', passwordHash, { mfa: true });
  await ensurePlatformUser('platform-admin@bp.test', 'PLATFORM_ADMIN', passwordHash);
  await ensurePlatformUser('support@bp.test', 'SUPPORT_AGENT', passwordHash);
  await ensurePlatformUser('billing@bp.test', 'BILLING_MANAGER', passwordHash);
}

async function ensurePlatformUser(
  email: string,
  roleKey: string,
  passwordHash: string,
  opts: { mfa?: boolean } = {},
) {
  const role = await unsafePrismaAdmin.role.findFirstOrThrow({
    where: { key: roleKey, organizationId: null },
    select: { id: true },
  });
  const existing = await unsafePrismaAdmin.appUser.findUnique({ where: { email } });
  if (existing) {
    await unsafePrismaAdmin.appUser.update({
      where: { id: existing.id },
      data: { platformRoleId: role.id, mfaEnabled: opts.mfa ?? false, passwordHash },
    });
    return existing;
  }
  return unsafePrismaAdmin.appUser.create({
    data: {
      authProvider: 'credentials',
      authSubject: email,
      email,
      fullName: `Platform ${roleKey}`,
      passwordHash,
      platformRoleId: role.id,
      mfaEnabled: opts.mfa ?? false,
    },
  });
}

// If invoked directly, run + disconnect.
if (import.meta.url === `file://${process.argv[1]}`) {
  seedRbacFixtures()
    .then(async () => {
      const [orgs, users, mems, branches, memBranches] = await Promise.all([
        unsafePrismaAdmin.organization.count(),
        unsafePrismaAdmin.appUser.count(),
        unsafePrismaAdmin.membership.count(),
        unsafePrismaAdmin.branch.count(),
        unsafePrismaAdmin.membershipBranch.count(),
      ]);
      console.log('✔ RBAC fixtures complete:', { orgs, users, mems, branches, memBranches });
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await unsafePrismaAdmin.$disconnect();
    });
}
