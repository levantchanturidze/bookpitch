import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { unsafePrismaAdmin } from '@/lib/db';

// -----------------------------------------------------------------------------
// P15-012 — regression proof for the suite lock.
//
// The defect: two vitest processes sharing one database clobber each other's
// fixtures. One run's `beforeEach` resets `mfa_last_totp_window` and the
// rate-limit buckets for the shared seeded super-admin while the other run is
// mid-request, and that request gets a 400 from a control doing its job. It
// surfaced as an intermittent "expected 400 to be 200" in
// tests/platform-break-glass.test.ts — roughly one full run in five, never with
// the file alone, never in CI (one process there).
//
// tests/global-setup.ts takes a run-scoped advisory lock so the second process
// fails immediately with an explanation instead of producing a misleading red.
//
// This test asserts the lock is ACTUALLY HELD right now, from a different
// database session — the property that makes a concurrent run impossible. A
// test that only checked the file's contents would pass even if the lock were
// never acquired.
// -----------------------------------------------------------------------------

const TEST_SUITE_LOCK_KEY = '7698234762';
const HOUSEKEEPING_LOCK_KEY = '7698234761';

describe('P15-012 suite lock', () => {
  it('is held for the duration of this run, as seen from another session', async () => {
    // Prisma is a different session from the pg.Client in global-setup, so a
    // try-lock here must fail while the run is in progress.
    const rows = await unsafePrismaAdmin.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_lock(${BigInt(TEST_SUITE_LOCK_KEY)}::bigint) AS acquired
    `;
    const acquired = rows[0]?.acquired === true;

    // Do not leak the lock if the assertion below is about to fail.
    if (acquired) {
      await unsafePrismaAdmin.$queryRaw`
        SELECT pg_advisory_unlock(${BigInt(TEST_SUITE_LOCK_KEY)}::bigint)
      `;
    }

    expect(
      acquired,
      'the suite lock was NOT held — a second concurrent run could corrupt this one',
    ).toBe(false);
  });

  it('is visible in pg_locks as a session-level advisory lock', async () => {
    const rows = await unsafePrismaAdmin.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND objid = (${BigInt(TEST_SUITE_LOCK_KEY)}::bigint & x'FFFFFFFF'::bigint)::oid
        AND granted
    `;
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('does not collide with the housekeeping advisory lock', () => {
    // lib/housekeeping.ts warns that its key must be unique across the
    // codebase. A collision would make the cron and the suite fight.
    expect(TEST_SUITE_LOCK_KEY).not.toBe(HOUSEKEEPING_LOCK_KEY);
    expect(readFileSync('lib/housekeeping.ts', 'utf8')).toContain(HOUSEKEEPING_LOCK_KEY);
  });

  it('is wired into vitest as globalSetup, not setupFiles', () => {
    // setupFiles cannot hold it: vitest forks a process per test file, so a
    // session lock taken there is released between files and a second run
    // slips through the gap. Measured during P15-012, not assumed.
    const config = readFileSync('vitest.config.ts', 'utf8');
    expect(config).toContain("globalSetup: ['tests/global-setup.ts']");
  });

  it('releases the lock on teardown so the next run can start', () => {
    const src = readFileSync('tests/global-setup.ts', 'utf8');
    expect(src).toContain('pg_advisory_unlock');
    expect(src).toMatch(/export async function teardown/);
  });
});
