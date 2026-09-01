import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { adminDbUrl } from './helpers/admin-db-url';

// -----------------------------------------------------------------------------
// The privileged connection string a few tests open for themselves.
//
// Two suites failed the first time this repository's CI ever executed the
// Phase 16 and Phase 17 work (run 33491923279) for the same reason: they read
// `ADMIN_DATABASE_URL`, which exists in a developer's .env.local and does not
// exist on a GitHub Actions runner. Locally they were green, which is the whole
// problem — the signal looked healthy and meant nothing.
//
// So the resolution order is pinned, and so is the rule that makes it matter:
// DATABASE_URL must never be the fallback. It points at the NOBYPASSRLS
// application role, and 20 tables carry FORCE RLS, so a lock probe running as
// that role would see no rows, take no lock, and answer "lockable" every time.
// -----------------------------------------------------------------------------

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

const VARS = [
  'DATABASE_URL_SUPERUSER_SESSION',
  'ADMIN_DATABASE_URL',
  'DATABASE_URL_SUPERUSER_DIRECT',
  'DATABASE_URL',
] as const;

const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

function setEnv(values: Partial<Record<(typeof VARS)[number], string | undefined>>) {
  for (const v of VARS) {
    const next = values[v];
    if (next === undefined) delete process.env[v];
    else process.env[v] = next;
  }
}

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v]!;
  }
});

describe('adminDbUrl resolution', () => {
  it('prefers DATABASE_URL_SUPERUSER_SESSION — the variable CI actually sets', () => {
    setEnv({
      DATABASE_URL_SUPERUSER_SESSION: 'postgresql://ci@localhost:5432/ci',
      ADMIN_DATABASE_URL: 'postgresql://dev@localhost:5432/dev',
    });
    expect(adminDbUrl()).toBe('postgresql://ci@localhost:5432/ci');
  });

  it('falls back to ADMIN_DATABASE_URL — the variable a developer sets', () => {
    setEnv({ ADMIN_DATABASE_URL: 'postgresql://dev@localhost:5432/dev' });
    expect(adminDbUrl()).toBe('postgresql://dev@localhost:5432/dev');
  });

  it('strips the query string, which pg rejects and Prisma accepts', () => {
    setEnv({ ADMIN_DATABASE_URL: 'postgresql://dev@localhost:5432/dev?pgbouncer=true&x=1' });
    expect(adminDbUrl()).toBe('postgresql://dev@localhost:5432/dev');
  });

  it('refuses rather than falling back to DATABASE_URL', () => {
    // The complement that matters. Falling back here would not throw — it would
    // quietly give the probe an RLS-bound role and make it always agree.
    setEnv({ DATABASE_URL: 'postgresql://bookpitch_app@localhost:5432/ci' });
    expect(() => adminDbUrl()).toThrow(/NOBYPASSRLS/);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('no test opens its own connection from a variable CI does not set', () => {
  it('nothing under tests/ builds its own connection string from process.env', () => {
    const offenders = walk(path.join(ROOT, 'tests'))
      .filter((f) => path.basename(f) !== 'admin-db-url.ts')
      .filter((f) => path.basename(f) !== 'admin-db-url.test.ts')
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        // Only files that open their own connection matter. tests/setup.ts and
        // tests/phase15-db-guard.test.ts name these variables as data — a list
        // of URL vars to guard, an injected fixture — and never connect with
        // them, so the `new Client(` requirement is what separates the two.
        if (!/new Client\(/.test(src)) return false;
        // DATABASE_URL is deliberately NOT listed. Two places open the app role
        // on purpose — tests/global-setup.ts takes the suite advisory lock on
        // the same connection the application uses, and phase12-owner-invariant
        // races two app-role clients because running as the app role IS the
        // thing under test. Those are correct and CI sets DATABASE_URL anyway.
        // The privileged variables are the ones that go missing on a runner.
        return /process\.env\.(ADMIN_DATABASE_URL|DATABASE_URL_SUPERUSER_SESSION|DATABASE_URL_SUPERUSER_DIRECT)\b/.test(
          src,
        );
      })
      .map((f) => path.relative(ROOT, f));
    expect(
      offenders,
      'use tests/helpers/admin-db-url.ts — ADMIN_DATABASE_URL is unset on a CI runner',
    ).toEqual([]);
  });

  it('COMPLEMENT: the scan reaches the files it claims to scan', () => {
    const scanned = walk(path.join(ROOT, 'tests')).length;
    expect(scanned).toBeGreaterThan(90);
  });
});
