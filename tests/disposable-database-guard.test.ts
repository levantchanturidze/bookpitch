import { describe, it, expect, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));

const { assertDisposableDatabase } = await import('@/prisma/_assert-disposable-database');

// -----------------------------------------------------------------------------
// The destructive-script guard, watched refusing.
//
// prisma/_require-local-db-guard.ts runs at import time, before .env.local is
// loaded, and its own header admits the gap: a bare invocation with nothing set
// at process start "proceeds silently" and then uses whatever .env.local
// supplies, unexamined. That is the most common way `npm run db:seed` is run,
// and it is allow-by-default — the one posture this repository keeps finding
// and removing.
//
// assertDisposableDatabase() closes it by asking the LIVE connection what
// database it is on, after the environment resolves and before anything is
// deleted. Every branch below is a way that check could be talked into
// approving a database nobody meant to wipe.
//
// Each case throws before any query runs, so none of these tests touch a
// database. The success path is exercised by `npm run db:seed` itself, which
// now prints its verified identity on every run.
// -----------------------------------------------------------------------------

const local = (db = 'bookpitch_dev', user = 'levan') =>
  `postgresql://${user}:pw@localhost:5432/${db}`;

describe('assertDisposableDatabase — refuses anything not provably throwaway', () => {
  it('refuses when NO database URL is set', async () => {
    // The exact hole in the import-time guard: nothing set means nothing
    // checked, and the target becomes whatever a later import resolves.
    await expect(assertDisposableDatabase({})).rejects.toThrow(/cannot be proven disposable/i);
  });

  it('refuses a managed-provider host even when the database name looks disposable', async () => {
    for (const host of [
      'db.abcdefgh.supabase.co',
      'aws-0-eu-central-1.pooler.supabase.com',
      'my-db.rds.amazonaws.com',
      'ep-cool-name.neon.tech',
      'prod-db.internal',
    ]) {
      await expect(
        assertDisposableDatabase({
          DATABASE_URL: `postgresql://u:pw@${host}:5432/bookpitch_dev`,
        }),
        host,
      ).rejects.toThrow(/production marker|not loopback/i);
    }
  });

  it('refuses a non-loopback host that matches no marker either', async () => {
    // Fail closed: an unrecognised host is refused, not assumed safe because it
    // did not happen to contain a known string.
    await expect(
      assertDisposableDatabase({
        DATABASE_URL: 'postgresql://u:pw@db.internal:5432/bookpitch_dev',
      }),
    ).rejects.toThrow(/not loopback/i);
  });

  it('refuses a database name outside the disposable allow-list', async () => {
    for (const db of ['bookpitch', 'bookpitch_production', 'postgres', 'main', '']) {
      await expect(
        assertDisposableDatabase({ DATABASE_URL: local(db) }),
        db || '(empty)',
      ).rejects.toThrow(/disposable allow-list|not a parseable/i);
    }
  });

  it('refuses when two variables point at DIFFERENT databases', async () => {
    // A script that resets one database and seeds another is a thing to learn
    // about before the reset, not halfway through it.
    await expect(
      assertDisposableDatabase({
        DATABASE_URL: local('bookpitch_dev'),
        ADMIN_DATABASE_URL: local('bookpitch_test'),
      }),
    ).rejects.toThrow(/two targets/i);
  });

  it('refuses when two variables point at different HOSTS', async () => {
    await expect(
      assertDisposableDatabase({
        DATABASE_URL: local('bookpitch_dev'),
        DATABASE_URL_SUPERUSER_MIGRATE:
          'postgresql://u:pw@db.abcdefgh.supabase.co:5432/bookpitch_dev',
      }),
    ).rejects.toThrow(/two targets|production marker/i);
  });

  it('refuses an unparseable URL rather than ignoring it', async () => {
    await expect(assertDisposableDatabase({ DATABASE_URL: 'not-a-url-at-all' })).rejects.toThrow(
      /parseable/i,
    );
  });

  it('never puts a password in the refusal message', async () => {
    // The refusal text is printed to a terminal and often pasted into an
    // issue. F-12: a credential must not travel in it.
    const secret = 'hunter2-should-never-appear';
    let message = '';
    try {
      await assertDisposableDatabase({
        DATABASE_URL: `postgresql://u:${secret}@db.abcdefgh.supabase.co:5432/bookpitch_dev`,
      });
      throw new Error('guard did not refuse');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/production marker/i);
    expect(message).not.toContain(secret);
  });
});
