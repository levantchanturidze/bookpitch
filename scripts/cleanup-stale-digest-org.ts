// One-shot cleanup: removes the stale digest-* org left by a crashed test
// session. Run once, then delete this script.
//
// Stale org: a7d9f8c9-58f2-4615-a98d-f2e98b4d502c (digest-1786547952340)
// Created by audit-digest.test.ts beforeAll whose afterAll never ran.

import { config as loadEnv } from 'dotenv';

if (!process.env.DATABASE_URL) {
  loadEnv();
  loadEnv({ path: '.env.local', override: true });
}

const STALE_ORG_ID = 'a7d9f8c9-58f2-4615-a98d-f2e98b4d502c';

async function main() {
  const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');

  console.log('Checking for stale org...');
  const org = await unsafePrismaAdmin.organization.findUnique({
    where: { id: STALE_ORG_ID },
    select: { id: true, name: true, status: true },
  });

  if (!org) {
    console.log('Stale org not found — nothing to clean up.');
    return;
  }

  console.log(`Found stale org: ${org.name} (${org.status})`);

  // 1. Disable audit_log triggers so we can delete rows that are FK-pinned.
  await unsafePrismaAdmin.$executeRawUnsafe('ALTER TABLE "audit_log" DISABLE TRIGGER USER');
  try {
    await withoutRls((tx) => tx.auditLog.deleteMany({ where: { organizationId: STALE_ORG_ID } }));
    console.log('Deleted audit_log rows.');
  } finally {
    await unsafePrismaAdmin.$executeRawUnsafe('ALTER TABLE "audit_log" ENABLE TRIGGER USER');
  }

  // 2. Find the actor user (from the membership).
  const memberships = await unsafePrismaAdmin.membership.findMany({
    where: { organizationId: STALE_ORG_ID },
    select: { userId: true },
  });
  const userIds = memberships.map((m) => m.userId);

  // 3. Delete memberships, customers, then org, then user.
  await withoutRls(async (tx) => {
    await tx.membership.deleteMany({ where: { organizationId: STALE_ORG_ID } });
    await tx.customer.deleteMany({ where: { organizationId: STALE_ORG_ID } });
    await tx.organization.delete({ where: { id: STALE_ORG_ID } });
    for (const uid of userIds) {
      const auditCount = await tx.auditLog.count({ where: { actorUserId: uid } });
      if (auditCount === 0) {
        await tx.appUser.delete({ where: { id: uid } }).catch(() => {});
      }
    }
  });

  console.log('Stale org cleaned up successfully.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
