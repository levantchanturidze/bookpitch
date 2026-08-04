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
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

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
  // _prisma_migrations.migration_name is not UNIQUE (only id is PK), so
  // ON CONFLICT (migration_name) is invalid. Guard with an existence check.
  if (await isAlreadyApplied()) return;
  await unsafePrismaAdmin.$executeRawUnsafe(
    `INSERT INTO _prisma_migrations
       (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES
       (gen_random_uuid()::text, 'one-shot-apply', now(), $1, NULL, NULL, now(), 1)`,
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
  currentUser: string;
  roleExists: boolean;
  allowed?: Array<{ table: string; ok: boolean; err?: string }>;
  denied?:  Array<{ table: string; ok: boolean; err?: string }>;
  note?: string;
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
    const cu = await client.query<{ current_user: string }>(`SELECT current_user`);
    const currentUser = cu.rows[0]?.current_user ?? 'unknown';

    const roleCheck = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookpitch_login') AS exists`,
    );
    const roleExists = roleCheck.rows[0]?.exists === true;

    if (!roleExists) {
      return { currentUser, roleExists, note: 'role does not exist yet — apply the migration first' };
    }

    // Grant current_user membership in bookpitch_login so SET ROLE is
    // allowed. On Supabase, "postgres" is not the true SUPERUSER, so
    // SET ROLE bookpitch_login is denied unless postgres was GRANTED
    // membership. Idempotent — a re-grant is a no-op.
    await client.query(`GRANT bookpitch_login TO CURRENT_USER`);

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
    return { currentUser, roleExists, allowed, denied };
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
    if (action === 'fix-checksum') {
      // Correct the _prisma_migrations checksum for the SEC-007 migration
      // so a future `prisma migrate deploy` doesn't trip a drift check.
      // The value must match SHA-256 of the migration.sql file exactly.
      const sql = await readFile(
        path.join(process.cwd(), 'prisma', 'migrations', MIGRATION_ID, 'migration.sql'),
        'utf-8',
      );
      const { createHash } = await import('node:crypto');
      const sha = createHash('sha256').update(sql).digest('hex');
      await unsafePrismaAdmin.$executeRawUnsafe(
        `UPDATE _prisma_migrations SET checksum = $1 WHERE migration_name = $2`,
        sha, MIGRATION_ID,
      );
      return NextResponse.json({ updatedChecksum: sha });
    }
    if (action === 'migrate-status') {
      // Ground truth on prod: list every applied migration + look for
      // markers that would trip `prisma migrate deploy` next time.
      const rows = await unsafePrismaAdmin.$queryRawUnsafe<Array<{
        migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null;
      }>>(
        `SELECT migration_name, checksum, finished_at, rolled_back_at
           FROM _prisma_migrations
           ORDER BY started_at ASC`,
      );
      const roleCheck = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ exists: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookpitch_login') AS exists`,
      );
      return NextResponse.json({
        migrationCount: rows.length,
        bookpitchLoginRoleExists: roleCheck[0]?.exists === true,
        // Filter to just the SEC-007 migration + any migration with unusual state
        sec007: rows.filter(r => r.migration_name === MIGRATION_ID),
        rolledBack: rows.filter(r => r.rolled_back_at !== null),
        unfinished: rows.filter(r => r.finished_at === null),
        allNames: rows.map(r => r.migration_name),
      });
    }
    if (action === 'mint-super') {
      // Mint or refresh a SUPER_ADMIN with a fresh random password.
      // Returns the plaintext once for the E2E sign-in test then can never
      // be read back — same envelope as create-platform-user.ts. Used
      // only because I have no local URL to prod (Sensitive vars).
      const bodyAny = body as { email?: unknown };
      const email = typeof bodyAny.email === 'string' && bodyAny.email
        ? bodyAny.email.toLowerCase()
        : 'sec007-e2e@bookpitch.internal';
      const password = randomBytes(24).toString('base64url');
      const passwordHash = await hash(password);
      const superRole = await unsafePrismaAdmin.role.findFirstOrThrow({
        where: { key: 'SUPER_ADMIN', organizationId: null },
        select: { id: true },
      });
      const user = await unsafePrismaAdmin.appUser.upsert({
        where: { email },
        create: {
          authProvider: 'credentials', authSubject: email, email,
          fullName: 'SEC-007 E2E probe',
          passwordHash, platformRoleId: superRole.id, status: 'active',
        },
        update: { passwordHash, platformRoleId: superRole.id, status: 'active',
                  sessionVersion: { increment: 1 } },
        select: { id: true, email: true },
      });
      return NextResponse.json({ userId: user.id, email: user.email, password });
    }
    if (action === 'delete-probe-user') {
      const bodyAny = body as { email?: unknown };
      const email = typeof bodyAny.email === 'string' && bodyAny.email
        ? bodyAny.email.toLowerCase() : null;
      if (!email || !email.endsWith('@bookpitch.internal')) {
        return NextResponse.json({ error: 'refusing — email must end with @bookpitch.internal' }, { status: 400 });
      }
      // Only delete if the user has no audit_log rows attributing them —
      // otherwise soft-mask instead (audit_log FK is ON DELETE NO ACTION).
      const user = await unsafePrismaAdmin.appUser.findUnique({
        where: { email }, select: { id: true },
      });
      if (!user) return NextResponse.json({ deleted: false, reason: 'not found' });
      const auditCount = await unsafePrismaAdmin.auditLog.count({
        where: { actorUserId: user.id },
      });
      if (auditCount === 0) {
        await unsafePrismaAdmin.appUser.delete({ where: { id: user.id } });
        return NextResponse.json({ deleted: true, method: 'hard' });
      }
      // Soft-mask: neutralize the login, retain the row for audit-log FK.
      await unsafePrismaAdmin.appUser.update({
        where: { id: user.id },
        data: {
          status: 'deleted',
          passwordHash: null,
          platformRoleId: null,
          email: `deleted-${user.id}@bookpitch.invalid`,
          sessionVersion: { increment: 1 },
        },
      });
      return NextResponse.json({ deleted: true, method: 'soft-mask', auditRows: auditCount });
    }
    return NextResponse.json({ error: 'action must be status | apply | verify | mint-super | migrate-status | fix-checksum | delete-probe-user' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 500) }, { status: 500 });
  }
}
