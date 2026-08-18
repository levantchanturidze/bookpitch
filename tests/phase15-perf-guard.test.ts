import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertSafeTarget } from '../scripts/perf-baseline.mjs';

// -----------------------------------------------------------------------------
// P15-007 — a load generator must not be able to point at production.
//
// `.github/workflows/load-test.yml` gated only on STAGING_URL being non-empty.
// Setting that secret to the production URL — one mistake in a settings page —
// would have pointed a weekly k6 run at the live service.
//
// The guard has to fail CLOSED: an unrecognised remote host is refused rather
// than allowed, because a deny-list stops working the moment a new hostname
// exists.
// -----------------------------------------------------------------------------

const OVERRIDE = 'i-understand-this-generates-load';

describe('P15-007 perf baseline refuses production targets', () => {
  it('allows loopback without any override', () => {
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3210', 'http://[::1]:3000']) {
      expect(() => assertSafeTarget(url)).not.toThrow();
    }
  });

  it('refuses the production domain', () => {
    for (const url of ['https://bookpitch.ge', 'https://BookPitch.GE/signin']) {
      expect(() => assertSafeTarget(url)).toThrow(/production marker/i);
    }
  });

  it('refuses production even when the override is set', () => {
    // The override exists for disposable remote environments, not as a way to
    // unlock production. If this ever passes, the guard is decorative.
    expect(() => assertSafeTarget('https://bookpitch.ge', { allowRemote: true })).toThrow(
      /production marker/i,
    );
  });

  it('refuses Vercel and Supabase hosts', () => {
    // A Preview deployment inherits production env vars unless overridden, so
    // load against a preview URL can reach the production database.
    for (const url of ['https://bookpitch-abc.vercel.app', 'https://db.supabase.co']) {
      expect(() => assertSafeTarget(url, { allowRemote: true })).toThrow(/production marker/i);
    }
  });

  it('fails closed on an unrecognised remote host', () => {
    expect(() => assertSafeTarget('https://something-new.example.com')).toThrow(/non-loopback/i);
  });

  it('allows an unrecognised remote host only with the explicit override', () => {
    expect(() =>
      assertSafeTarget('https://staging.example.com', { allowRemote: true }),
    ).not.toThrow();
  });

  it('rejects a malformed URL rather than treating it as safe', () => {
    expect(() => assertSafeTarget('not-a-url')).toThrow();
  });
});

describe('P15-007 the load-test workflow carries the same guard', () => {
  const workflow = readFileSync('.github/workflows/load-test.yml', 'utf8');

  it('has a step that refuses production', () => {
    expect(workflow).toContain('Refuse to load-test production');
  });

  it('checks every production marker the script checks', () => {
    for (const marker of ['bookpitch.ge', 'vercel.app', 'supabase.co']) {
      expect(workflow).toContain(marker);
    }
  });

  it('runs the guard before k6 is invoked', () => {
    // Order matters: a guard after the load step is not a guard.
    expect(workflow.indexOf('Refuse to load-test production')).toBeLessThan(
      workflow.indexOf('k6 run'),
    );
  });

  it('never echoes the target URL', () => {
    // The URL is a secret; only the derived host may reach the log.
    expect(workflow).not.toMatch(/echo\s+"?\$\{?TARGET_URL/);
  });
});
