import { describe, it, expect } from 'vitest';
import {
  isE2ETurnstileBypass,
  isE2ELoopbackRuntime,
  isLoopbackAppUrl,
} from '@/lib/auth/e2e-runtime';

// -----------------------------------------------------------------------------
// P17-009 — the test-only Turnstile credential cannot activate in production.
//
// §4 of the phase brief asks for "tests proving the bypass cannot activate
// under production configuration". The case that matters is not "it works in
// tests" — it is the one where the variable HAS leaked into production and the
// attacker is sending exactly the right token. That must still refuse.
//
// The guard is APP_URL on loopback, deliberately not NODE_ENV. NODE_ENV is
// 'production' under `next start`, which is when the E2E suite runs, so a
// NODE_ENV guard would be one the tests themselves had to defeat — and a guard
// the test suite defeats is not a guard.
// -----------------------------------------------------------------------------

const GOOD = 'e2e-turnstile-bypass-token-0123456789abcdef'; // 43 chars
const PROD_URL = 'https://bookpitch.ge';
const LOCAL_URL = 'http://localhost:3210';

const env = (over: Record<string, string | undefined>): Record<string, string | undefined> => ({
  APP_URL: LOCAL_URL,
  E2E_TURNSTILE_BYPASS_TOKEN: GOOD,
  ...over,
});

describe('the bypass is refused under production configuration', () => {
  it('REFUSES on the production domain even with the variable set and the token correct', () => {
    // The whole point. A leaked variable plus a leaked token is still not
    // enough, because production is not served from localhost.
    expect(isE2ETurnstileBypass(GOOD, env({ APP_URL: PROD_URL }))).toBe(false);
  });

  it('REFUSES on any non-loopback host', () => {
    for (const url of [
      'https://bookpitch.ge',
      'https://www.bookpitch.ge',
      'https://bookpitch-git-main-padelebi-s-projects.vercel.app',
      'https://localhost.attacker.example',
      'https://127.0.0.1.attacker.example',
      'http://192.168.1.10:3000',
      'http://10.0.0.5',
    ]) {
      expect(isE2ETurnstileBypass(GOOD, env({ APP_URL: url })), url).toBe(false);
    }
  });

  it('REFUSES when APP_URL is absent or unparseable — absence is not permission', () => {
    expect(isE2ETurnstileBypass(GOOD, env({ APP_URL: undefined }))).toBe(false);
    expect(isE2ETurnstileBypass(GOOD, env({ APP_URL: '' }))).toBe(false);
    expect(isE2ETurnstileBypass(GOOD, env({ APP_URL: 'not a url' }))).toBe(false);
    expect(isE2ETurnstileBypass(GOOD, env({ APP_URL: '///' }))).toBe(false);
  });

  it('REFUSES when the variable is unset, even on loopback', () => {
    expect(isE2ETurnstileBypass(GOOD, env({ E2E_TURNSTILE_BYPASS_TOKEN: undefined }))).toBe(false);
    expect(isE2ETurnstileBypass('', env({ E2E_TURNSTILE_BYPASS_TOKEN: undefined }))).toBe(false);
  });

  it('REFUSES a credential shorter than 32 characters, even if it matches', () => {
    // A guessable bypass value is worse than none: it looks like a control.
    for (const weak of ['x', 'test', 'bypass', 'a'.repeat(31)]) {
      expect(isE2ETurnstileBypass(weak, env({ E2E_TURNSTILE_BYPASS_TOKEN: weak })), weak).toBe(
        false,
      );
    }
    expect(
      isE2ETurnstileBypass('a'.repeat(32), env({ E2E_TURNSTILE_BYPASS_TOKEN: 'a'.repeat(32) })),
    ).toBe(true);
  });

  it('REFUSES a token that does not match exactly', () => {
    expect(isE2ETurnstileBypass(GOOD + 'x', env({}))).toBe(false);
    expect(isE2ETurnstileBypass(GOOD.slice(0, -1), env({}))).toBe(false);
    expect(isE2ETurnstileBypass(GOOD.toUpperCase(), env({}))).toBe(false);
    expect(isE2ETurnstileBypass(' ' + GOOD, env({}))).toBe(false);
  });

  it('REFUSES an absent, empty or non-string token', () => {
    expect(isE2ETurnstileBypass(null, env({}))).toBe(false);
    expect(isE2ETurnstileBypass(undefined, env({}))).toBe(false);
    expect(isE2ETurnstileBypass('', env({}))).toBe(false);
    expect(isE2ETurnstileBypass(123 as unknown as string, env({}))).toBe(false);
  });
});

describe('COMPLEMENT — it does work where it is supposed to', () => {
  it('accepts the exact token on loopback', () => {
    // Without this the suite above could pass by always returning false.
    expect(isE2ETurnstileBypass(GOOD, env({}))).toBe(true);
  });

  it('accepts on every loopback spelling the E2E runner might use', () => {
    for (const url of [
      'http://localhost:3210',
      'http://localhost',
      'http://127.0.0.1:3210',
      'http://[::1]:3210',
      'https://LOCALHOST:3210',
    ]) {
      expect(isE2ETurnstileBypass(GOOD, env({ APP_URL: url })), url).toBe(true);
    }
  });
});

describe('isE2ELoopbackRuntime — the single gate everything test-only keys off', () => {
  it('REFUSES the production domain even with the credential set', () => {
    // lib/onboarding.ts::resolveAppUrl relaxes its HTTPS and no-localhost rules
    // behind this. If it ever returned true in production, verification links
    // could be built over plain HTTP.
    expect(isE2ELoopbackRuntime(env({ APP_URL: PROD_URL }))).toBe(false);
  });

  it('REFUSES when the credential is absent or weak', () => {
    expect(isE2ELoopbackRuntime(env({ E2E_TURNSTILE_BYPASS_TOKEN: undefined }))).toBe(false);
    expect(isE2ELoopbackRuntime(env({ E2E_TURNSTILE_BYPASS_TOKEN: 'short' }))).toBe(false);
  });

  it('COMPLEMENT: accepts a loopback run with a strong credential', () => {
    expect(isE2ELoopbackRuntime(env({}))).toBe(true);
  });

  it('an empty environment is not an E2E runtime', () => {
    expect(isE2ELoopbackRuntime({})).toBe(false);
  });
});

describe('isLoopbackAppUrl', () => {
  it('matches only the host, never a substring of it', () => {
    expect(isLoopbackAppUrl('http://localhost:3000')).toBe(true);
    expect(isLoopbackAppUrl('http://127.0.0.1/')).toBe(true);
    // The classic bypass shapes.
    expect(isLoopbackAppUrl('https://localhost.evil.example')).toBe(false);
    expect(isLoopbackAppUrl('https://evil.example/?x=localhost')).toBe(false);
    expect(isLoopbackAppUrl('https://evil.example#localhost')).toBe(false);
    expect(isLoopbackAppUrl('https://user@localhost.evil.example')).toBe(false);
  });
});
