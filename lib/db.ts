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
// Connection URL naming (SEC-007 rename — env var name states the DB role
// AND its privilege, so a future operator can't wire a superuser URL into a
// slot expecting a NOBYPASSRLS one without noticing):
//
//   • DATABASE_URL_APP_NOBYPASSRLS     — runtime bookpitch_app (NOBYPASSRLS,
//     NOSUPERUSER). Powers prismaApp. Legacy name: DATABASE_URL (fallback).
//
//   • DATABASE_URL_SUPERUSER_TXPOOL    — runtime superuser (postgres,
//     BYPASSRLS via SUPERUSER) via transaction pool (Supabase 6543,
//     ?pgbouncer=true). Powers unsafePrismaAdmin. Preferred at runtime — no
//     session-pool slot pressure. Legacy name: ADMIN_RUNTIME_DATABASE_URL.
//
//   • DATABASE_URL_SUPERUSER_SESSION   — runtime superuser via session pool
//     (port 5432). Fallback for unsafePrismaAdmin when the tx-pool URL isn't
//     set. Consumes one session-pool slot per client. Legacy name:
//     ADMIN_DATABASE_URL.
//
//   • DATABASE_URL_SUPERUSER_MIGRATE   — superuser via session pool, used by
//     .github/workflows/migrate.yml for `prisma migrate deploy`. Migrations
//     need session persistence for advisory locks. Legacy name:
//     ADMIN_MIGRATE_DATABASE_URL.
//
//   • DATABASE_URL_APP_REPLICA         — bookpitch_app on a read replica
//     endpoint (still NOBYPASSRLS). Optional; falls back to prismaApp when
//     unset. Legacy name: DATABASE_REPLICA_URL.
//
// The legacy names remain valid as fallbacks so existing deployments keep
// working; new deployments should use the new names. Documented in
// .env.example and docs/rbac-security-review.md § SEC-007.
//
// Both are HMR-safe via globalThis caching.
// -----------------------------------------------------------------------------

type CachedClients = {
  prismaApp: PrismaClient | undefined;
  unsafePrismaAdmin: PrismaClient | undefined;
  prismaLogin: PrismaClient | undefined;
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

// New names first, legacy names as fallback so operators can migrate at
// their own pace. SEC-007: the new names document the DB role's privilege
// in the variable name itself; the legacy names hid it.
const APP_URL =
  process.env.DATABASE_URL_APP_NOBYPASSRLS ?? process.env.DATABASE_URL;
const SUPERUSER_URL =
  process.env.DATABASE_URL_SUPERUSER_TXPOOL ??
  process.env.DATABASE_URL_SUPERUSER_SESSION ??
  process.env.ADMIN_RUNTIME_DATABASE_URL ??
  process.env.ADMIN_DATABASE_URL ??
  APP_URL;
const REPLICA_URL =
  process.env.DATABASE_URL_APP_REPLICA ?? process.env.DATABASE_REPLICA_URL;
// SEC-007 narrow-role URL. When set, powers the login/auth-context hot path
// via a role with BYPASSRLS but SELECT grants ONLY on the auth-graph tables
// (app_users, memberships, organizations, roles, role_permissions,
// membership_branches, impersonation_sessions, break_glass_sessions). If
// unset, prismaLogin falls back to unsafePrismaAdmin — same behavior as
// today, no runtime change. Operator setup: run the
// 20260804000000_bookpitch_login_role migration (creates the role), set a
// password via `ALTER USER bookpitch_login WITH PASSWORD '...'` in the
// Supabase SQL editor, add the URL as DATABASE_URL_LOGIN in Vercel.
const LOGIN_URL = process.env.DATABASE_URL_LOGIN;

// Report by the new name so misconfiguration diagnostics point at the
// canonical env var. If a caller ONLY set a legacy name, the message
// still tells them which new name to add.
export const prismaApp: PrismaClient =
  globalForPrisma.prismaApp ?? build(APP_URL, 'DATABASE_URL_APP_NOBYPASSRLS');

export const unsafePrismaAdmin: PrismaClient =
  globalForPrisma.unsafePrismaAdmin ??
  build(SUPERUSER_URL, 'DATABASE_URL_SUPERUSER_TXPOOL');

// SEC-007 narrow-role client. If DATABASE_URL_LOGIN is set, this is a
// distinct PrismaClient backed by the bookpitch_login role — BYPASSRLS
// (necessary for the pre-tenant auth queries) but with SELECT grants on
// only 8 auth-graph tables. Any accidental query outside that set fails
// with `permission denied for table X` at the Postgres layer, shrinking
// the blast radius of the hot path from "every table" to "auth tables."
//
// Until the operator sets the password + env var, this transparently
// aliases to unsafePrismaAdmin — zero runtime change. lib/rbac/context.ts
// imports THIS symbol; the fallback keeps buildAuthContext working
// throughout the operator setup delay.
export const prismaLogin: PrismaClient =
  globalForPrisma.prismaLogin ??
  (LOGIN_URL
    ? build(LOGIN_URL, 'DATABASE_URL_LOGIN')
    : unsafePrismaAdmin);

// Read replica — falls back to prismaApp when the replica URL is unset so
// dev never breaks. Only used by lib/db-replica.ts::withOrgReplica for
// explicitly-read-only surfaces (analytics, audit log viewer).
// Replica-eligible callers MUST tolerate eventual consistency: a write
// that just happened on primary may not yet be visible via the replica.
export const prismaReplica: PrismaClient =
  globalForPrisma.prismaReplica ??
  (REPLICA_URL
    ? build(REPLICA_URL, 'DATABASE_URL_APP_REPLICA')
    : prismaApp);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prismaApp = prismaApp;
  globalForPrisma.unsafePrismaAdmin = unsafePrismaAdmin;
  globalForPrisma.prismaLogin = prismaLogin;
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
