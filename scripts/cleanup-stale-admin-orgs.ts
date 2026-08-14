import { config as loadEnv } from 'dotenv';
if (!process.env.DATABASE_URL) {
  loadEnv();
  loadEnv({ path: '.env.local', override: true });
}

async function main() {
  const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');
  const staleNames = ['Admin Fixture Org', 'Other Admin Org'];
  for (const name of staleNames) {
    const org = await unsafePrismaAdmin.organization.findFirst({
      where: { name, status: { not: 'archived' }, ownerUserId: null },
      select: { id: true, name: true },
    });
    if (!org) {
      console.log('not found:', name);
      continue;
    }

    await unsafePrismaAdmin.$executeRawUnsafe('ALTER TABLE "audit_log" DISABLE TRIGGER USER');
    try {
      await withoutRls(async (tx) => {
        await tx.auditLog.deleteMany({ where: { organizationId: org.id } });
        await tx.membership.deleteMany({ where: { organizationId: org.id } });
        await tx.location.deleteMany({ where: { organizationId: org.id } });
        await tx.customer.deleteMany({ where: { organizationId: org.id } });
        await tx.organization.delete({ where: { id: org.id } });
      });
      console.log('deleted org:', org.name, org.id);
    } finally {
      await unsafePrismaAdmin.$executeRawUnsafe('ALTER TABLE "audit_log" ENABLE TRIGGER USER');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
