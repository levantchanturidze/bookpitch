import 'dotenv/config';
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

// Phase 4: tests always run in enforcing mode. The env var is set here
// (not in .env.local) so a developer can override it for a shadow-mode
// dry-run: `RBAC_ENFORCE_MODULES= npm test` disables enforcement.
if (!process.env.RBAC_ENFORCE_MODULES) {
  process.env.RBAC_ENFORCE_MODULES = '*';
}
