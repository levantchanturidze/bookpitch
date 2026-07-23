import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// -----------------------------------------------------------------------------
// Two Prisma clients, backed by two Postgres roles:
//   • prismaApp   → connects as `bookpitch_app` (NOSUPERUSER, NOBYPASSRLS).
//                   All tenant-scoped queries go through `withOrg(orgId, fn)`
//                   which wraps them in a tx that sets `app.current_org_id`
//                   for RLS policies to consume.
//   • prismaAdmin → connects as the OS superuser (locally `levan`; on Supabase
//                   this would be the service_role). Bypasses RLS. Used by
//                   seed, migrations (via prisma.config.ts), and the login
//                   lookup (via `withoutRls`) where org context isn't known
//                   yet.
//
// Both are HMR-safe via globalThis caching.
// -----------------------------------------------------------------------------

type CachedClients = {
  prismaApp: PrismaClient | undefined;
  prismaAdmin: PrismaClient | undefined;
  prismaReplica: PrismaClient | undefined;
};
const globalForPrisma = globalThis as unknown as CachedClients;

function build(connectionString: string | undefined, label: string): PrismaClient {
  if (!connectionString) {
    throw new Error(`${label} is not set — check .env.local`);
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prismaApp: PrismaClient =
  globalForPrisma.prismaApp ?? build(process.env.DATABASE_URL, 'DATABASE_URL');

export const prismaAdmin: PrismaClient =
  globalForPrisma.prismaAdmin ??
  build(process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL, 'ADMIN_DATABASE_URL');

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
  globalForPrisma.prismaAdmin = prismaAdmin;
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
  return prismaAdmin.$transaction(async (tx) => fn(tx));
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
