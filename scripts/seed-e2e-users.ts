import './../prisma/_require-local-db-guard';
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import { hash } from '@node-rs/argon2';
import {
  ORG_ROLE_ACCOUNTS,
  PLATFORM_ROLE_ACCOUNTS,
  E2E_EMAIL_DOMAIN,
  e2ePassword,
} from '../e2e/fixtures/roles';

// -----------------------------------------------------------------------------
// P17-010 — one signed-in identity per role, for the browser suite.
//
//   npm run e2e:seed
//
// The repository already seeds users, but only for four of the thirteen roles,
// and it does not cover the two whose landing differs from everyone else's:
// ACCOUNTANT lands on /analytics and MARKETING on /patients. Those are exactly
// the roles a landing regression hits first, and exactly the ones no browser
// test could reach.
//
// Memberships attach to the EXISTING primary development organisation rather
// than to a fresh one. A new org has no locations, services or staff, so
// /scheduler and /analytics would render an empty or error state and the test
// would be asserting on the wrong thing. Attaching to the seeded org means each
// role sees the surface a real member of that org sees.
//
// The legacy `memberships.role` enum only has owner | practitioner |
// receptionist. It is not what routing reads — auth resolves roleKey from
// `membership.roleRef.key` (lib/auth/credentials.ts) — so each account gets the
// closest legacy value and the authoritative RBAC role via roleId.
//
// Idempotent: safe to run before every E2E execution.
// -----------------------------------------------------------------------------

/** Legacy enum stand-in. Routing reads roleId, never this. */
const LEGACY_ENUM: Record<string, 'owner' | 'practitioner' | 'receptionist'> = {
  ORG_OWNER: 'owner',
  ORG_ADMIN: 'owner',
  BRANCH_MANAGER: 'receptionist',
  SENIOR_PROVIDER: 'practitioner',
  FRONT_DESK: 'receptionist',
  PROVIDER: 'practitioner',
  ACCOUNTANT: 'receptionist',
  MARKETING: 'receptionist',
};

async function main(): Promise<void> {
  // Imported dynamically, AFTER the dotenv calls above. lib/db.ts throws at
  // module load when no connection URL is present, and a static import would
  // be hoisted above loadEnv() — prisma/seed.ts avoids this only because
  // prisma.config.ts loads .env.local before the seed runs. This script has no
  // such bootstrap.
  const { unsafePrismaAdmin } = await import('@/lib/db');

  const passwordHash = await hash(e2ePassword());

  // The primary development organisation — the one with locations, services
  // and staff. "Isolation Corp" exists to prove tenant separation and must not
  // be used here.
  const org = await unsafePrismaAdmin.organization.findFirstOrThrow({
    where: { name: { not: 'Isolation Corp' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  const locationCount = await unsafePrismaAdmin.location.count({
    where: { organizationId: org.id },
  });
  if (locationCount === 0) {
    throw new Error(
      `E2E seeding target "${org.name}" has no locations — run \`npm run db:seed\` first, ` +
        'otherwise every authenticated landing renders an empty state and the ' +
        'journey tests assert on nothing.',
    );
  }

  const systemRoles = await unsafePrismaAdmin.role.findMany({
    where: { organizationId: null, isSystem: true },
    select: { id: true, key: true },
  });
  const roleIdByKey = new Map(systemRoles.map((r) => [r.key, r.id]));

  let created = 0;
  let reused = 0;

  for (const [roleKey, email] of Object.entries(ORG_ROLE_ACCOUNTS)) {
    const roleId = roleIdByKey.get(roleKey);
    if (!roleId) throw new Error(`system role ${roleKey} is not seeded`);

    const user = await unsafePrismaAdmin.appUser.upsert({
      where: { email },
      // Re-hash on every run so a changed E2E_PASSWORD takes effect rather
      // than leaving accounts that silently refuse the new password.
      update: { passwordHash },
      create: {
        email,
        authProvider: 'credentials',
        authSubject: email,
        fullName: `E2E ${roleKey}`,
        passwordHash,
      },
      select: { id: true },
    });

    const existing = await unsafePrismaAdmin.membership.findFirst({
      where: { organizationId: org.id, userId: user.id },
      select: { id: true, roleId: true },
    });
    if (existing) {
      if (existing.roleId !== roleId) {
        await unsafePrismaAdmin.membership.update({
          where: { id: existing.id },
          data: { roleId, status: 'active' },
        });
      }
      reused++;
    } else {
      await unsafePrismaAdmin.membership.create({
        data: {
          organizationId: org.id,
          userId: user.id,
          role: LEGACY_ENUM[roleKey],
          roleId,
          status: 'active',
        },
      });
      created++;
    }
  }

  for (const [roleKey, email] of Object.entries(PLATFORM_ROLE_ACCOUNTS)) {
    const roleId = roleIdByKey.get(roleKey);
    if (!roleId) throw new Error(`system role ${roleKey} is not seeded`);
    await unsafePrismaAdmin.appUser.upsert({
      where: { email },
      update: { passwordHash, platformRoleId: roleId },
      create: {
        email,
        authProvider: 'credentials',
        authSubject: email,
        fullName: `E2E ${roleKey}`,
        passwordHash,
        platformRoleId: roleId,
        // No MFA: the seeded SUPER_ADMIN has it enabled, which is why the
        // suite uses PLATFORM_ADMIN instead of weakening that account.
        mfaEnabled: false,
      },
    });
  }

  const total = await unsafePrismaAdmin.appUser.count({
    where: { email: { endsWith: E2E_EMAIL_DOMAIN } },
  });
  console.log(
    `E2E accounts ready: ${total} total (${created} membership(s) created, ${reused} reused) ` +
      `in org "${org.name}"`,
  );
}

main()
  .then(async () => {
    const { unsafePrismaAdmin } = await import('@/lib/db');
    await unsafePrismaAdmin.$disconnect();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
