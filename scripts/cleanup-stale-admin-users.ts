import { config as loadEnv } from 'dotenv';
if (!process.env.DATABASE_URL) {
  loadEnv();
  loadEnv({ path: '.env.local', override: true });
}

async function main() {
  const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');
  const emails = ['admin-owner@bookpitch.dev', 'other-admin-owner@bookpitch.dev'];
  for (const email of emails) {
    const u = await unsafePrismaAdmin.appUser.findFirst({
      where: { email },
      select: { id: true },
    });
    if (!u) {
      console.log('not found', email);
      continue;
    }

    // Disable audit triggers to allow deleting actor rows
    await unsafePrismaAdmin.$executeRawUnsafe('ALTER TABLE "audit_log" DISABLE TRIGGER USER');
    try {
      await withoutRls(async (tx) => {
        await tx.auditLog.deleteMany({ where: { actorUserId: u.id } });
        await tx.membership.deleteMany({ where: { userId: u.id } });
        await tx.appUser.delete({ where: { id: u.id } });
      });
      console.log('deleted', email);
    } finally {
      await unsafePrismaAdmin.$executeRawUnsafe('ALTER TABLE "audit_log" ENABLE TRIGGER USER');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
