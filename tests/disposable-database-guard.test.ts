import { describe, it, expect, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));

const { assertDisposableDatabase, isPubliclyRoutable } =
  await import('@/prisma/_assert-disposable-database');

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

// ---------------------------------------------------------------------------
// The server-address rule, which CI caught being wrong.
//
// It started as "must be loopback" and refused the CI database — Postgres runs
// there as a service container, so the client connects to localhost and the
// server answers from a Docker bridge address like 172.18.0.2. That is the
// most disposable database in the system, and a loopback-only rule rejected it
// while accepting nothing safer.
//
// What the check is actually for is narrower: a connection REDIRECTED somewhere
// the URL never named — a pooler, a tunnel, a rewritten DSN. Those land on
// public addresses.
// ---------------------------------------------------------------------------
describe('isPubliclyRoutable — what counts as "somewhere else"', () => {
  it('accepts container and private networks, which is where disposable databases live', () => {
    for (const addr of [
      '127.0.0.1', // host loopback
      '172.18.0.2', // the CI service container this rule originally refused
      '172.31.255.254', // top of the RFC1918 172.16/12 block
      '10.1.2.3',
      '192.168.1.10',
      '169.254.1.1', // link-local
      '::1',
      'fd00::1', // IPv6 ULA
      'fe80::1', // IPv6 link-local
    ]) {
      expect(isPubliclyRoutable(addr), addr).toBe(false);
    }
  });

  it('refuses publicly routable addresses', () => {
    for (const addr of ['8.8.8.8', '52.1.2.3', '172.32.0.1', '172.15.0.1', '2606:4700::1111']) {
      expect(isPubliclyRoutable(addr), addr).toBe(true);
    }
  });

  it('gets the RFC1918 172.16/12 boundaries exactly right', () => {
    // The classic off-by-one in this range: 172.16-172.31 is private, 172.15
    // and 172.32 are not. Getting it wrong either refuses CI or admits a
    // public host.
    expect(isPubliclyRoutable('172.16.0.1')).toBe(false);
    expect(isPubliclyRoutable('172.31.0.1')).toBe(false);
    expect(isPubliclyRoutable('172.15.255.255')).toBe(true);
    expect(isPubliclyRoutable('172.32.0.0')).toBe(true);
  });
});
