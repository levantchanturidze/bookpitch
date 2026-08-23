import 'dotenv/config';
import { prismaApp, unsafePrismaAdmin } from '@/lib/db';
import { config as loadEnv } from 'dotenv';

// Vitest runs from the repo root; load .env.local like Next.js does.
loadEnv({ path: '.env.local', override: true });

// -----------------------------------------------------------------------------
// P15-008 — database identity guard.
//
// This suite is not read-only. It creates organisations, users, customers,
// appointments and audit rows, and its cleanup hooks call deleteMany. Nothing
// stopped it from doing all of that against production: the guard in
// prisma/_require-local-db-guard.ts covers the seed scripts only, and it
// evaluates before .env.local is loaded, so it cannot see the URL the tests
// actually connect with.
//
// Today the repository is safe purely by accident — .env.local happens to
// point at localhost. An exported DATABASE_URL in the shell, or one edited
// .env.local, is all it would take.
//
// FAILS CLOSED. An unrecognised host is refused, not permitted. A deny-list
// would stop working the moment a new production hostname exists, so the
// allow-list decides and the production markers are only a second line.
// -----------------------------------------------------------------------------

const DISPOSABLE_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  // The service-container hostname on a GitHub Actions runner network.
  'postgres',
]);

// Present as defence in depth. The allow-list above already rejects these.
const PRODUCTION_MARKERS = ['supabase', 'pooler', 'neon.tech', 'rds.amazonaws', 'bookpitch.ge'];

const DB_URL_VARS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'ADMIN_DATABASE_URL',
  'DATABASE_URL_SUPERUSER_SESSION',
  'DATABASE_URL_SUPERUSER_TXPOOL',
  'DATABASE_URL_APP_NOBYPASSRLS',
] as const;

/**
 * Exported so a test can prove the guard actually refuses, rather than
 * trusting that it would. Returns the sanitised host on success; throws
 * otherwise. Never includes a credential in the message.
 */
export function assertDisposableDatabase(
  env: Record<string, string | undefined> = process.env,
): { variable: string; host: string; database: string }[] {
  const checked: { variable: string; host: string; database: string }[] = [];

  for (const variable of DB_URL_VARS) {
    const raw = (env[variable] ?? '').trim();
    if (!raw) continue;

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`[db guard] ${variable} is not a parseable URL — refusing to run tests.`);
    }

    const host = url.hostname.toLowerCase().replace(/^\[(.+)\]$/, '$1');
    const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || '(none)';

    for (const marker of PRODUCTION_MARKERS) {
      if (host.includes(marker)) {
        throw new Error(
          `[db guard] ${variable} host "${host}" contains production marker "${marker}". ` +
            `This suite writes and deletes rows. Refusing to run.`,
        );
      }
    }

    if (!DISPOSABLE_HOSTS.has(host)) {
      throw new Error(
        `[db guard] ${variable} host "${host}" is not in the disposable-host allow-list ` +
          `(${[...DISPOSABLE_HOSTS].join(', ')}). This suite writes and deletes rows, so an ` +
          `unrecognised host is refused rather than assumed safe.`,
      );
    }

    checked.push({ variable, host, database });
  }

  if (checked.length === 0) {
    throw new Error(
      '[db guard] no database URL is set, so the target cannot be proven non-production. ' +
        'Refusing to run rather than failing open.',
    );
  }

  return checked;
}

assertDisposableDatabase();

// -----------------------------------------------------------------------------
// Network guard — no test may contact a metadata, link-local or otherwise
// non-approved address.
//
// A Phase 16 complement test asserted an SSRF defect by letting the unfixed
// action really call http://169.254.169.254/. It could not succeed here (this
// host has no link-local route and no metadata service, and the attempt timed
// out), but proving a request-forgery bug by attempting the forgery is the
// wrong method: on a cloud runner the same test would have reached a real
// metadata endpoint.
//
// Outbound requests to loopback stay allowed, because Playwright and the
// local disposable server legitimately use them. Everything on this list is
// refused before a socket is opened, so a future test cannot reintroduce the
// mistake by accident.
// -----------------------------------------------------------------------------
const BLOCKED_HOSTS = new Set([
  '169.254.169.254', // AWS / Azure / GCP / DO IMDS
  '169.254.170.2', // ECS task metadata
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // AWS IMDSv6
]);

const BLOCKED_SCHEMES = new Set(['file:', 'gopher:', 'ftp:', 'data:']);

function refuseUnsafeTarget(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return; // relative URL — no host to reach
  }

  if (BLOCKED_SCHEMES.has(url.protocol)) {
    throw new Error(`[net guard] refusing ${url.protocol} request in tests: ${url.protocol}//…`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[(.+)\]$/, '$1');
  if (BLOCKED_HOSTS.has(host) || host.startsWith('169.254.') || host.startsWith('fe80:')) {
    throw new Error(
      `[net guard] refusing a request to "${host}". Metadata and link-local ` +
        `addresses are never a valid test target — stub fetch instead.`,
    );
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const target =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  refuseUnsafeTarget(target);
  return realFetch(input as RequestInfo, init);
}) as typeof globalThis.fetch;

export { refuseUnsafeTarget as __assertSafeFetchTarget };

// Phase 4: tests always run in enforcing mode. The env var is set here
// (not in .env.local) so a developer can override it for a shadow-mode
// dry-run: `RBAC_ENFORCE_MODULES= npm test` disables enforcement.
if (!process.env.RBAC_ENFORCE_MODULES) {
  process.env.RBAC_ENFORCE_MODULES = '*';
}

// -----------------------------------------------------------------------------
// Fixture cleanup guard — `where: { id: undefined }` is not a no-op.
//
// Prisma drops undefined filter values, so deleteMany({ where: { id: undefined } })
// becomes deleteMany({}) and matches the whole table. Teardown code reaches that
// state the moment a beforeAll fails before assigning its ids — which happened
// while writing the Phase 16 fixtures, and only the org_owner invariant stopped
// a dev table from being emptied.
//
// The pattern is in 34 test files, so this guards the call rather than editing
// each one: any deleteMany/updateMany whose `where` carries an undefined value
// throws instead of silently widening. Legitimate calls are unaffected, because
// they never pass undefined.
//
// Test-scoped on purpose: it wraps the imported client instances here and never
// ships in application code.
// -----------------------------------------------------------------------------
function findUndefinedFilter(where: unknown, path = 'where'): string | null {
  if (where === null || typeof where !== 'object') return null;
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (value === undefined) return `${path}.${key}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = findUndefinedFilter(value, `${path}.${key}`);
      if (nested) return nested;
    }
  }
  return null;
}

function guardBulkWrites(client: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(client)) {
    if (key.startsWith('$') || key.startsWith('_')) continue;
    const delegate = client[key] as Record<string, unknown> | undefined;
    if (!delegate || typeof delegate !== 'object') continue;
    for (const op of ['deleteMany', 'updateMany'] as const) {
      const original = delegate[op];
      if (typeof original !== 'function') continue;
      const guardedFn = function guarded(args?: { where?: unknown }) {
        const offending = args?.where === undefined ? null : findUndefinedFilter(args.where);
        if (offending) {
          throw new Error(
            `[fixture guard] ${label}.${key}.${op}() was given ${offending} = undefined. ` +
              `Prisma drops undefined filters, so this would match EVERY row. ` +
              `Guard the id (\`if (!id) return\`) or delete by an explicit value.`,
          );
        }
        return (original as (a?: unknown) => unknown).call(delegate, args);
      };
      (guardedFn as unknown as { __fixtureGuarded?: boolean }).__fixtureGuarded = true;
      delegate[op] = guardedFn;
    }
  }
}

guardBulkWrites(unsafePrismaAdmin as unknown as Record<string, unknown>, 'unsafePrismaAdmin');
if ((prismaApp as unknown) !== (unsafePrismaAdmin as unknown)) {
  guardBulkWrites(prismaApp as unknown as Record<string, unknown>, 'prismaApp');
}

export { findUndefinedFilter as __findUndefinedFilter };
