import { config as loadEnv } from 'dotenv';
if (!process.env.DATABASE_URL) {
  loadEnv();
  loadEnv({ path: '.env.local', override: true });
}

async function main() {
  const { unsafePrismaAdmin } = await import('@/lib/db');
  const rows = await unsafePrismaAdmin.$queryRawUnsafe<
    Array<{
      id: string;
      name: string;
      status: string;
      owner_user_id: string | null;
      created_at: Date;
    }>
  >(
    "SELECT id, name, status, owner_user_id, created_at FROM organizations WHERE status != 'archived' AND owner_user_id IS NULL ORDER BY created_at DESC LIMIT 10",
  );
  console.log('Orphan orgs (non-archived, no owner_user_id):');
  console.log(JSON.stringify(rows, null, 2));
  for (const org of rows) {
    const membs = await unsafePrismaAdmin.$queryRawUnsafe<
      Array<{ role: string; status: string; user_id: string }>
    >(`SELECT role, status, user_id FROM memberships WHERE organization_id = '${org.id}'`);
    console.log(`Org ${org.name}: memberships = ${JSON.stringify(membs)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
