import { describe, it, expect } from 'vitest';
import { assertDisposableDatabase } from './setup';

// -----------------------------------------------------------------------------
// P15-008 — prove the database identity guard refuses.
//
// The suite creates organisations, users, customers and appointments, and its
// cleanup hooks call deleteMany. Before this guard, nothing prevented all of
// that from running against production: prisma/_require-local-db-guard.ts
// covers only the seed scripts, and it evaluates before .env.local is loaded,
// so it never sees the URL the tests actually use.
//
// A guard nobody has watched refuse is not a guard, so every branch is
// exercised here with an injected environment.
// -----------------------------------------------------------------------------

const local = (db = 'bookpitch_dev') => `postgresql://u:p@localhost:5432/${db}`;

describe('P15-008 database identity guard', () => {
  it('accepts a loopback target', () => {
    expect(() => assertDisposableDatabase({ DATABASE_URL: local() })).not.toThrow();
  });

  it('accepts the CI service-container hostname', () => {
    expect(() =>
      assertDisposableDatabase({ DATABASE_URL: 'postgresql://u:p@postgres:5432/bookpitch_ci' }),
    ).not.toThrow();
  });

  it('refuses a managed-provider host', () => {
    expect(() =>
      assertDisposableDatabase({
        DATABASE_URL: 'postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres',
      }),
    ).toThrow(/production marker "supabase"/);
  });

  it('refuses a pooler host', () => {
    expect(() =>
      assertDisposableDatabase({
        DATABASE_URL: 'postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
      }),
    ).toThrow(/production marker/);
  });

  it('fails closed on an unrecognised host rather than allowing it', () => {
    // The important branch. A deny-list would let this through.
    expect(() =>
      assertDisposableDatabase({ DATABASE_URL: 'postgresql://u:p@db.internal.example:5432/x' }),
    ).toThrow(/not in the disposable-host allow-list/);
  });

  it('refuses when no database URL is set at all', () => {
    expect(() => assertDisposableDatabase({})).toThrow(/cannot be proven non-production/);
  });

  it('refuses an unparseable URL', () => {
    expect(() => assertDisposableDatabase({ DATABASE_URL: 'not a url' })).toThrow(
      /not a parseable URL/,
    );
  });

  it('checks every database variable, not only DATABASE_URL', () => {
    // A safe DATABASE_URL alongside a production ADMIN_DATABASE_URL must still
    // refuse — several helpers connect through the admin URL.
    expect(() =>
      assertDisposableDatabase({
        DATABASE_URL: local(),
        ADMIN_DATABASE_URL: 'postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres',
      }),
    ).toThrow(/ADMIN_DATABASE_URL/);
  });

  it('never puts a credential in the failure message', () => {
    try {
      assertDisposableDatabase({
        DATABASE_URL: 'postgresql://admin:sup3rs3cret@db.abcdefgh.supabase.co:5432/postgres',
      });
      throw new Error('guard did not refuse');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('sup3rs3cret');
      expect(message).not.toContain('admin:');
    }
  });

  it('reports the host it actually validated', () => {
    const checked = assertDisposableDatabase({ DATABASE_URL: local('bookpitch_dev') });
    expect(checked).toContainEqual({
      variable: 'DATABASE_URL',
      host: 'localhost',
      database: 'bookpitch_dev',
    });
  });
});
