import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// -----------------------------------------------------------------------------
// Two Prisma clients, backed by two Postgres roles:
//   • prismaApp   → connects as `bookpitch_app` (NOSUPERUSER, NOBYPASSRLS).
//                   All tenant-scoped queries go through `withOrg(orgId, fn)`
//                   which wraps them in a tx that sets `app.current_org_id`
//                   for RLS policies to consume. This is the second layer of
//                   defense the spec (§9 tenant isolation) depends on —
//                   RLS is the enforcer even if a WHERE clause is wrong.
//
//   • unsafePrismaAdmin → connects as the DB superuser (`postgres` on
//                   Supabase, `levan` locally). BYPASSRLS, full DDL, no
//                   tenant filter. Every query on this client is a
//                   deliberate second-layer waiver — the *only* protection
//                   is the WHERE clause the caller writes. Legitimate uses:
//                     - login / password-reset lookup (no org context yet)
//                     - buildAuthContext (needs suspended-org gate
//                       BEFORE tenant scope applies)
//                     - platform-plane operations (SUPER/PLATFORM roles
//                       operate cross-tenant by design)
//                     - system crons + Stripe webhook (no session)
//                     - DDL in db-partitions cron
//                   The `unsafe` prefix is deliberate: importing it must
//                   be a visible acknowledgement at the callsite. New
//                   uses in ordinary org-plane request handlers should
//                   go through `withOrg` instead (SEC-007 — see
//                   docs/rbac-security-review.md).
//
// Connection URL precedence for unsafePrismaAdmin (F-11 mitigation):
//   1. ADMIN_RUNTIME_DATABASE_URL — transaction-pool (Supabase port 6543,
//      with ?pgbouncer=true). Uses no session-pool slots, so it doesn't
//      compete with prismaApp for the 15-client ceiling. RECOMMENDED for
//      Vercel prod.
//   2. ADMIN_DATABASE_URL — session-pool (port 5432). Falls back for local
//      dev and older env setups. Consumes a session slot per client.
//   3. DATABASE_URL — last-resort fallback so nothing crashes locally.
//
// Migrations (prisma migrate deploy) still use ADMIN_MIGRATE_DATABASE_URL
// via .github/workflows/migrate.yml — migrations need session persistence
// for advisory locks, so they can't share the transaction-pool URL.
//
// Both are HMR-safe via globalThis caching.
// -----------------------------------------------------------------------------

type CachedClients = {
  prismaApp: PrismaClient | undefined;
  unsafePrismaAdmin: PrismaClient | undefined;
  prismaReplica: PrismaClient | undefined;
};
const globalForPrisma = globalThis as unknown as CachedClients;

// Supabase's free-tier session-mode pooler caps at 15 clients (port 5432).
// Per Vercel serverless function invocation, the default pg pool max=10 —
// two concurrent cold starts blow the ceiling. Cap the per-client pool at
// PG_POOL_MAX (default 3) so even 5 concurrent functions leave headroom.
// Callers on paid tiers can raise it via env.
const POOL_MAX = Number(process.env.PG_POOL_MAX ?? 3);

function build(connectionString: string | undefined, label: string): PrismaClient {
  if (!connectionString) {
    throw new Error(`${label} is not set — check .env.local`);
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: POOL_MAX }),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prismaApp: PrismaClient =
  globalForPrisma.prismaApp ?? build(process.env.DATABASE_URL, 'DATABASE_URL');

export const unsafePrismaAdmin: PrismaClient =
  globalForPrisma.unsafePrismaAdmin ??
  build(
    process.env.ADMIN_RUNTIME_DATABASE_URL ??
      process.env.ADMIN_DATABASE_URL ??
      process.env.DATABASE_URL,
    'ADMIN_RUNTIME_DATABASE_URL',
  );

// Read replica — falls back to prismaApp when DATABASE_REPLICA_URL is
// unset so dev never breaks. Only used by lib/db-replica.ts::withOrgReplica
// for explicitly-read-only surfaces (analytics, audit log viewer).
// Replica-eligible callers MUST tolerate eventual consistency: a write
// that just happened on primary may not yet be visible via the replica.
export const prismaReplica: PrismaClient =
  globalForPrisma.prismaReplica ??
  (process.env.DATABASE_REPLICA_URL
    ? build(process.env.DATABASE_REPLICA_URL, 'DATABASE_REPLICA_URL')
    : prismaApp);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prismaApp = prismaApp;
  globalForPrisma.unsafePrismaAdmin = unsafePrismaAdmin;
  globalForPrisma.prismaReplica = prismaReplica;
}

/**
 * Run `fn` inside a tenant-scoped Postgres transaction. Sets
 * `app.current_org_id = orgId` so RLS policies from the add_rls migration
 * filter every query to `orgId`.
 *
 * `orgId` MUST be a validated uuid (call site: from the JWT session, never
 * from user input). Prisma disallows params in SET LOCAL — we string-embed.
 */
export async function withOrg<T>(
  orgId: string,
  fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) {
    throw new Error(`withOrg: invalid orgId "${orgId}"`);
  }
  return prismaApp.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_org_id = '${orgId}'`);
    return fn(tx);
  });
}

/**
 * Paths that must bypass RLS (login lookup, system tasks). Uses the admin
 * client (superuser) so BYPASSRLS is honored.
 */
export async function withoutRls<T>(
  fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return unsafePrismaAdmin.$transaction(async (tx) => fn(tx));
}

/**
 * Read-only tenant-scoped tx routed to the replica when configured (falls
 * back to primary transparently). Sets app.current_org_id so RLS policies
 * still apply — the replica connects as bookpitch_app too.
 *
 * CALLER CONTRACT: use ONLY for surfaces that can tolerate replica lag
 * (analytics rollups, audit-log viewer, list-heavy pages that never write
 * back in the same request). Never for read-then-write within a single
 * user action — use withOrg for that.
 */
export async function withOrgReplica<T>(
  orgId: string,
  fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) {
    throw new Error(`withOrgReplica: invalid orgId "${orgId}"`);
  }
  return prismaReplica.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_org_id = '${orgId}'`);
    return fn(tx);
  });
}
