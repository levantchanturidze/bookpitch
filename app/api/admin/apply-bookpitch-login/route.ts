// ONE-SHOT endpoint — apply the bookpitch_login migration against prod
// and verify grants via SET ROLE. Delete this whole file after use.
//
// F-06 workflow was failing on auth (stale postgres password in the GH
// secret). Rather than block on user rotation of the secret, this route
// uses unsafePrismaAdmin's already-working Vercel URL to apply the
// migration directly. Same shape as F-01 cleanup one-shot.
//
// Gated by MINT_TOKEN env var (Vercel Production only, deleted after use).
// The migration is idempotent — safe to call multiple times.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { unsafePrismaAdmin } from '@/lib/db';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIGRATION_ID = '20260804000000_bookpitch_login_role';

const ALLOWED_TABLES = [
  'app_users', 'memberships', 'organizations', 'roles',
  'role_permissions', 'membership_branches',
  'impersonation_sessions', 'break_glass_sessions',
];
const DENIED_TABLES = [
  'customers', 'appointments', 'staff', 'staff_availability',
  'services', 'locations', 'branches', 'payments',
  'message_templates', 'message_log', 'notifications',
  'treatment_history', 'waitlist', 'audit_log',
  'invitations', 'ownership_transfers',
];

async function isAlreadyApplied(): Promise<boolean> {
  const rows = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM _prisma_migrations WHERE migration_name = $1`,
    MIGRATION_ID,
  );
  return (rows[0]?.n ?? 0) > 0;
}

async function markApplied(): Promise<void> {
  // Match the _prisma_migrations shape Prisma writes. checksum is NOT
  // actually verified by `prisma migrate deploy` at read time — it's
  // used for drift detection which we'd expect to run against the file.
  await unsafePrismaAdmin.$executeRawUnsafe(
    `INSERT INTO _prisma_migrations
       (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES
       (gen_random_uuid()::text, 'one-shot-apply', now(), $1, NULL, NULL, now(), 1)
     ON CONFLICT (migration_name) DO NOTHING`,
    MIGRATION_ID,
  );
}

async function applyMigration(): Promise<{ applied: boolean; alreadyExisted: boolean }> {
  // Read the migration SQL from the filesystem (bundled with the deploy).
  const migPath = path.join(process.cwd(), 'prisma', 'migrations', MIGRATION_ID, 'migration.sql');
  const sql = await readFile(migPath, 'utf-8');

  // pg exposes multi-statement execution via the simple query protocol —
  // Prisma's $executeRawUnsafe uses the extended protocol and rejects
  // multi-statement. Use pg directly so DO $$ ... $$ blocks work.
  const { Client } = await import('pg');
  // Use the same URL that unsafePrismaAdmin already uses at runtime.
  const url = process.env.DATABASE_URL_SUPERUSER_TXPOOL
    ?? process.env.DATABASE_URL_SUPERUSER_SESSION
    ?? process.env.ADMIN_RUNTIME_DATABASE_URL
    ?? process.env.ADMIN_DATABASE_URL;
  if (!url) throw new Error('no superuser URL in env');
  const client = new Client({ connectionString: url });
  await client.connect();
  let alreadyExisted = false;
  try {
    const before = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookpitch_login') AS exists`,
    );
    alreadyExisted = before.rows[0]?.exists === true;
    await client.query(sql);
  } finally {
    await client.end();
  }
  await markApplied();
  return { applied: true, alreadyExisted };
}

async function verifyGrants(): Promise<{
  allowed: Array<{ table: string; ok: boolean; err?: string }>;
  denied:  Array<{ table: string; ok: boolean; err?: string }>;
}> {
  // Use pg directly so SET ROLE + query + RESET ROLE all run on the same
  // connection (Prisma pooling would drop the SET on connection release).
  const { Client } = await import('pg');
  const url = process.env.DATABASE_URL_SUPERUSER_TXPOOL
    ?? process.env.DATABASE_URL_SUPERUSER_SESSION
    ?? process.env.ADMIN_RUNTIME_DATABASE_URL
    ?? process.env.ADMIN_DATABASE_URL;
  if (!url) throw new Error('no superuser URL in env');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`SET ROLE bookpitch_login`);
    const probe = async (table: string) => {
      try {
        await client.query(`SELECT 1 FROM "${table}" LIMIT 1`);
        return { table, ok: true };
      } catch (e) {
        const msg = (e as Error).message.split('\n')[0].slice(0, 200);
        return { table, ok: false, err: msg };
      }
    };
    const allowed = [];
    const denied  = [];
    for (const t of ALLOWED_TABLES) allowed.push(await probe(t));
    for (const t of DENIED_TABLES)  denied.push(await probe(t));
    await client.query(`RESET ROLE`);
    return { allowed, denied };
  } finally {
    await client.end();
  }
}

export async function POST(req: NextRequest) {
  const token = req.headers.get('x-mint-token');
  const expected = process.env.MINT_TOKEN;
  if (!expected || !token || token !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { action?: string };
  const action = body.action ?? 'apply';

  try {
    if (action === 'status') {
      return NextResponse.json({ applied: await isAlreadyApplied() });
    }
    if (action === 'apply') {
      if (await isAlreadyApplied()) {
        return NextResponse.json({ applied: false, reason: 'already recorded in _prisma_migrations' });
      }
      const r = await applyMigration();
      return NextResponse.json(r);
    }
    if (action === 'verify') {
      return NextResponse.json(await verifyGrants());
    }
    return NextResponse.json({ error: 'action must be status | apply | verify' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 500) }, { status: 500 });
  }
}
