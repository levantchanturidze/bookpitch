import { config as loadEnv } from 'dotenv';

// Same caller-intent-wins pattern as scripts/create-platform-user.ts —
// see the footgun note there. Only fall back to dotfiles if the caller
// hasn't already provided DATABASE_URL inline.
if (!process.env.DATABASE_URL) {
  loadEnv();
  loadEnv({ path: '.env.local', override: true });
}

// -----------------------------------------------------------------------------
// scripts/create-test-org.ts
//
// Creates or updates a prod-safe test fixture so you can exercise the RBAC
// §6.2 matrix end-to-end against production without touching real data. No
// deleteMany. No wipe. Fully idempotent — re-running only fills gaps.
//
// Fixture:
//   • Two orgs:  "Test Clinic (bookpitch-test)"
//                "Test Clinic 2 (bookpitch-test)"
//   • Two branches in Test Clinic: "Downtown" and "Uptown"
//     (via Phase 2 sync trigger — creating Location auto-creates Branch).
//   • Users (all `@bookpitch-test.invalid` so they can never collide with
//     a real customer email):
//       owner@bookpitch-test.invalid       → ORG_OWNER (Test Clinic)
//       admin@bookpitch-test.invalid       → ORG_ADMIN
//       manager@bookpitch-test.invalid     → BRANCH_MANAGER, scoped to Downtown only
//       frontdesk@bookpitch-test.invalid   → FRONT_DESK
//       provider@bookpitch-test.invalid    → PROVIDER
//       accountant@bookpitch-test.invalid  → ACCOUNTANT
//       solo@bookpitch-test.invalid        → ORG_OWNER of a SECOND separate
//                                            "Solo Practice" org (spec §2.3 case);
//                                            ORG_OWNER already implies all PROVIDER
//                                            permissions via role_permissions grant
//       multi@bookpitch-test.invalid       → PROVIDER in Test Clinic AND
//                                            Test Clinic 2 (multi-membership case)
//
// Passwords are generated with crypto-strong randomness and printed ONCE at
// the end for each NEW user. For existing users the password column shows
// "(existing — unchanged)". Pass --reset-passwords to force-rotate all.
//
// Usage:
//   DATABASE_URL="$(grep '^ADMIN_DATABASE_URL' .env.supabase | cut -d= -f2- | tr -d '"')" \
//     npx tsx scripts/create-test-org.ts [--reset-passwords]
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('error: DATABASE_URL is not set');
    process.exit(1);
  }
  const resetPasswords = process.argv.includes('--reset-passwords');

  const { hash } = await import('@node-rs/argon2');
  const { unsafePrismaAdmin } = await import('@/lib/db');
  const { LocationType } = await import('@prisma/client');

  // -----------------------------------------------------------------------
  // Helpers — every one is idempotent.
  // -----------------------------------------------------------------------

  async function upsertOrg(name: string) {
    const existing = await unsafePrismaAdmin.organization.findFirst({
      where: { name },
      select: { id: true, name: true },
    });
    if (existing) return existing;
    return unsafePrismaAdmin.organization.create({
      data: { name },
      select: { id: true, name: true },
    });
  }

  async function ensureLocationAndBranch(orgId: string, name: string, type: 'clinic' | 'salon') {
    // Phase 2 sync trigger auto-creates a Branch when a Location is inserted,
    // linked via branches.legacy_location_id = locations.id.
    const loc = await unsafePrismaAdmin.location.findFirst({
      where: { organizationId: orgId, name },
      select: { id: true, name: true },
    });
    let locationId: string;
    if (loc) locationId = loc.id;
    else {
      const created = await unsafePrismaAdmin.location.create({
        data: {
          organizationId: orgId,
          name,
          type: type === 'clinic' ? LocationType.clinic : LocationType.salon,
        },
        select: { id: true },
      });
      locationId = created.id;
    }
    // Branch might already be there (trigger or prior run). Look it up.
    let branch = await unsafePrismaAdmin.branch.findFirst({
      where: { organizationId: orgId, legacyLocationId: locationId },
      select: { id: true, name: true },
    });
    if (!branch) {
      // Fallback: create branch manually if the trigger didn't fire (older
      // migrations, or org was created before Phase 2).
      branch = await unsafePrismaAdmin.branch.create({
        data: { organizationId: orgId, name, legacyLocationId: locationId },
        select: { id: true, name: true },
      });
    }
    return { locationId, branchId: branch.id, branchName: branch.name };
  }

  type UserOutcome = { email: string; created: boolean; password: string | null };

  async function upsertUser(email: string, fullName: string): Promise<UserOutcome> {
    const existing = await unsafePrismaAdmin.appUser.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing && !resetPasswords) {
      return { email, created: false, password: null };
    }
    // Generate a strong password: 32 chars, url-safe alphabet.
    const password = randomBytes(24).toString('base64url');
    const passwordHash = await hash(password);
    if (existing) {
      await unsafePrismaAdmin.appUser.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          status: 'active',
          sessionVersion: { increment: 1 }, // invalidate any live JWT
        },
      });
    } else {
      await unsafePrismaAdmin.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: email,
          email,
          fullName,
          passwordHash,
          status: 'active',
        },
      });
    }
    return { email, created: !existing, password };
  }

  async function ensureMembership(
    orgId: string,
    userEmail: string,
    legacyRole: 'owner' | 'practitioner' | 'receptionist',
    systemRoleKey: string,
  ) {
    const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: userEmail },
      select: { id: true },
    });
    const role = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: systemRoleKey, organizationId: null },
      select: { id: true },
    });
    const existing = await unsafePrismaAdmin.membership.findFirst({
      where: { organizationId: orgId, userId: user.id },
      select: { id: true, roleId: true, status: true },
    });
    if (existing) {
      if (existing.roleId !== role.id || existing.status !== 'active') {
        await unsafePrismaAdmin.membership.update({
          where: { id: existing.id },
          data: { roleId: role.id, status: 'active', role: legacyRole as never },
        });
      }
      return existing.id;
    }
    const created = await unsafePrismaAdmin.membership.create({
      data: {
        organizationId: orgId,
        userId: user.id,
        role: legacyRole as never,
        roleId: role.id,
        status: 'active',
      },
      select: { id: true },
    });
    return created.id;
  }

  async function scopeToBranches(membershipId: string, branchIds: string[]) {
    // Idempotent: remove any existing scopes not in the desired set, then
    // add missing ones. For test env we just re-add the intended set.
    const existing = await unsafePrismaAdmin.membershipBranch.findMany({
      where: { membershipId },
      select: { branchId: true },
    });
    const have = new Set(existing.map((r) => r.branchId));
    const want = new Set(branchIds);
    for (const b of have) {
      if (!want.has(b)) {
        await unsafePrismaAdmin.membershipBranch.delete({
          where: { membershipId_branchId: { membershipId, branchId: b } },
        });
      }
    }
    for (const b of want) {
      if (!have.has(b)) {
        await unsafePrismaAdmin.membershipBranch.create({
          data: { membershipId, branchId: b },
        });
      }
    }
  }

  async function ensureOrgOwnerPointer(orgId: string, ownerEmail: string) {
    const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: ownerEmail },
      select: { id: true },
    });
    await unsafePrismaAdmin.organization.update({
      where: { id: orgId },
      data: { ownerUserId: user.id },
    });
  }

  // -----------------------------------------------------------------------
  // Build the fixture.
  // -----------------------------------------------------------------------

  console.log('creating test fixture...');

  const testClinic = await upsertOrg('Test Clinic (bookpitch-test)');
  const testClinic2 = await upsertOrg('Test Clinic 2 (bookpitch-test)');
  const soloPractice = await upsertOrg('Solo Practice (bookpitch-test)');

  const downtown = await ensureLocationAndBranch(testClinic.id, 'Downtown', 'clinic');
  const uptown = await ensureLocationAndBranch(testClinic.id, 'Uptown', 'clinic');
  // Test Clinic 2 gets its own location so multi-membership tests can hit it
  await ensureLocationAndBranch(testClinic2.id, 'TC2 Main', 'clinic');
  // Solo Practice: single location for the §2.3 solo practitioner
  await ensureLocationAndBranch(soloPractice.id, 'Solo Main', 'clinic');

  // Users first — must exist before memberships / owner-pointer updates.
  const users: Record<string, UserOutcome> = {};
  users.owner = await upsertUser('owner@bookpitch-test.invalid', 'Test Owner');
  users.admin = await upsertUser('admin@bookpitch-test.invalid', 'Test Admin');
  users.manager = await upsertUser('manager@bookpitch-test.invalid', 'Test Branch Manager');
  users.frontdesk = await upsertUser('frontdesk@bookpitch-test.invalid', 'Test Front Desk');
  users.provider = await upsertUser('provider@bookpitch-test.invalid', 'Test Provider');
  users.accountant = await upsertUser('accountant@bookpitch-test.invalid', 'Test Accountant');
  users.solo = await upsertUser('solo@bookpitch-test.invalid', 'Test Solo Doc');
  users.multi = await upsertUser('multi@bookpitch-test.invalid', 'Test Multi Provider');

  // Test Clinic memberships. Note: legacy `role` enum only has
  // owner|practitioner|receptionist; the authoritative RBAC pointer is
  // `roleId` (set from systemRoleKey). We pick the legacy value that
  // most-closely matches (`owner` for anything admin-tier so it satisfies
  // the enum) — Phase 2 backfill has already established that the
  // dual-write is required through the Contract migration.
  const ownerMemId = await ensureMembership(testClinic.id, users.owner.email, 'owner', 'ORG_OWNER');
  await ensureMembership(testClinic.id, users.admin.email, 'owner', 'ORG_ADMIN');
  const mgrMemId = await ensureMembership(
    testClinic.id,
    users.manager.email,
    'receptionist',
    'BRANCH_MANAGER',
  );
  await ensureMembership(testClinic.id, users.frontdesk.email, 'receptionist', 'FRONT_DESK');
  await ensureMembership(testClinic.id, users.provider.email, 'practitioner', 'PROVIDER');
  await ensureMembership(testClinic.id, users.accountant.email, 'receptionist', 'ACCOUNTANT');
  await ensureMembership(testClinic.id, users.multi.email, 'practitioner', 'PROVIDER');

  // Solo practice: solo user is ORG_OWNER (permissions include everything a
  // PROVIDER can do). Spec §2.3 says the single-membership row carries both hats.
  await ensureMembership(soloPractice.id, users.solo.email, 'owner', 'ORG_OWNER');

  // Test Clinic 2: multi user gets a second membership so the org switcher
  // has something to switch between; owner of TC2 is the same solo user for
  // convenience (satisfies the not-null ownerUserId later — see helper).
  await ensureMembership(testClinic2.id, users.solo.email, 'owner', 'ORG_OWNER');
  await ensureMembership(testClinic2.id, users.multi.email, 'practitioner', 'PROVIDER');

  // Owner pointers — the RBAC check assertNotLastOwner reads owner_user_id.
  await ensureOrgOwnerPointer(testClinic.id, users.owner.email);
  await ensureOrgOwnerPointer(testClinic2.id, users.solo.email);
  await ensureOrgOwnerPointer(soloPractice.id, users.solo.email);

  // Branch scoping — manager sees Downtown ONLY.
  await scopeToBranches(mgrMemId, [downtown.branchId]);
  // Owner: unrestricted (empty set) — no-op, but call it to prove idempotence.
  await scopeToBranches(ownerMemId, []);

  // -----------------------------------------------------------------------
  // Report.
  // -----------------------------------------------------------------------

  const rows: Array<[string, string, string, string]> = [];
  for (const [key, u] of Object.entries(users)) {
    rows.push([
      key,
      u.email,
      u.created ? 'NEW' : 'existing',
      u.password ?? '(existing — unchanged)',
    ]);
  }

  console.log('');
  console.log('=== TEST FIXTURE READY ===');
  console.log(
    `Test Clinic  id=${testClinic.id}  branches: Downtown=${downtown.branchId}, Uptown=${uptown.branchId}`,
  );
  console.log(`Test Clinic 2 id=${testClinic2.id}`);
  console.log(`Solo Practice id=${soloPractice.id}`);
  console.log('');
  console.log('Accounts — copy passwords NOW; they are printed once.');
  const w = { key: 12, email: 40, state: 10 };
  console.log(
    `  ${'label'.padEnd(w.key)}  ${'email'.padEnd(w.email)}  ${'state'.padEnd(w.state)}  password`,
  );
  console.log(
    `  ${'-'.repeat(w.key)}  ${'-'.repeat(w.email)}  ${'-'.repeat(w.state)}  ${'-'.repeat(32)}`,
  );
  for (const [k, e, s, p] of rows) {
    console.log(`  ${k.padEnd(w.key)}  ${e.padEnd(w.email)}  ${s.padEnd(w.state)}  ${p}`);
  }
  console.log('');
  console.log('Rotate passwords immediately by signing in and using /reset.');
  console.log(
    'Re-run with --reset-passwords to regenerate all (bumps sessionVersion so live JWTs die).',
  );

  await unsafePrismaAdmin.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
