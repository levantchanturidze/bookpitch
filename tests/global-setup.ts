import { Client } from 'pg';
import { config as loadEnv } from 'dotenv';

loadEnv();
loadEnv({ path: '.env.local', override: true });

// -----------------------------------------------------------------------------
// P15-012 — refuse to run two suites against one database at the same time.
//
// The suite shares a single database and runs files serially for that reason
// (fileParallelism: false in vitest.config.ts). Nothing stopped a SECOND vitest
// process from running against the same database concurrently, and when that
// happens the two runs clobber each other's fixtures: one run's `beforeEach`
// resets `mfa_last_totp_window` and the rate-limit buckets for the shared
// seeded super-admin while the other is mid-request, and that one gets a 400
// from a control doing exactly its job.
//
// That is what P15-012 actually was. It presented as an order-dependent flake
// in tests/platform-break-glass.test.ts ("expected 400 to be 200"), reproduced
// in roughly one full run in five, never reproduced with the file alone, and
// never in CI — because CI runs exactly one process. It was self-inflicted: a
// background run of the break-glass file was still going when a full
// `npm test` was started.
//
// This has to be globalSetup, not setupFiles. Vitest forks a process per test
// file, so a session-scoped lock taken in setupFiles is released when each
// file's process exits, leaving gaps a second run slips through — measured, not
// assumed. globalSetup runs once in the main process and holds one connection
// for the whole run.
// -----------------------------------------------------------------------------

/** Stable key; must not collide with HOUSEKEEPING_LOCK_KEY in lib/housekeeping.ts. */
const TEST_SUITE_LOCK_KEY = '7698234762';

let client: Client | null = null;

export async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return; // tests/setup.ts owns the "no database configured" failure.

  client = new Client({ connectionString: url });
  await client.connect();

  const { rows } = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
    [TEST_SUITE_LOCK_KEY],
  );

  if (!rows[0]?.acquired) {
    await client.end().catch(() => {});
    client = null;
    throw new Error(
      '[suite lock] another test run already holds this database.\n' +
        "Two vitest processes sharing one database corrupt each other's fixtures and\n" +
        'produce failures that look like flaky tests (P15-012). Wait for the other run\n' +
        'to finish, or point DATABASE_URL at a different disposable database.',
    );
  }
}

export async function teardown(): Promise<void> {
  if (!client) return;
  // Releasing explicitly rather than relying on disconnect keeps the lock from
  // lingering if the connection is pooled somewhere upstream.
  await client
    .query('SELECT pg_advisory_unlock($1::bigint)', [TEST_SUITE_LOCK_KEY])
    .catch(() => {});
  await client.end().catch(() => {});
  client = null;
}
