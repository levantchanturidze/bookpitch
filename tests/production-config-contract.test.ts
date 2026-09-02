import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  REQUIRED_SIGNUP_ENV,
  REQUIRED_EMAIL_ENV,
  requiredProviderCredentials,
  PROVIDER_CONTRACT,
  REQUIRED_SECURITY_ENV,
  missingEnv,
  collectConfigMetrics,
} from '@/lib/ops-metrics';

// -----------------------------------------------------------------------------
// Phase 13 regression tests for the production-only signup outage.
//
// What actually happened, 2026-08-16: production signup returned
// 400 {"error":"invalid request"} for every request. Two causes, both invisible
// to the existing suite:
//
//   1. TURNSTILE_EXPECTED_ACTION and TURNSTILE_ALLOWED_HOSTNAMES were never set
//      in Vercel Production. verifyTurnstile() fails closed without them, so no
//      token could ever be accepted. Tests set their own env, so they passed.
//
//   2. The signup page rendered the Turnstile widget from the script's `load`
//      event. `window.turnstile` is not guaranteed to exist at that moment, the
//      render call was guarded, the guard returned early, and nothing retried.
//      Zero widget iframes on production; the submit button never enabled.
//
// The tests below pin the contract for (1) and the retry behaviour for (2).
// -----------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');

describe('the required-production-env contract names the variables that broke signup', () => {
  it('includes the two Turnstile binding variables verifyTurnstile fails closed on', () => {
    expect(REQUIRED_SIGNUP_ENV).toContain('TURNSTILE_EXPECTED_ACTION');
    expect(REQUIRED_SIGNUP_ENV).toContain('TURNSTILE_ALLOWED_HOSTNAMES');
  });

  it('matches the env vars app/api/onboard/route.ts actually reads', () => {
    // If someone adds a new mandatory env read to the signup path, this test
    // fails until the monitor's contract is updated with it.
    const route = readFileSync(path.join(ROOT, 'app', 'api', 'onboard', 'route.ts'), 'utf8');
    const readNames = new Set(
      [...route.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
    );
    const turnstileNames = [...readNames].filter((n) => n.startsWith('TURNSTILE'));
    expect(turnstileNames.length).toBeGreaterThan(0);
    for (const name of turnstileNames) {
      expect(
        REQUIRED_SIGNUP_ENV as readonly string[],
        `${name} is read but not in the contract`,
      ).toContain(name);
    }
  });

  it('covers email and security configuration too', () => {
    // REQUIRED_EMAIL_ENV used to hard-code Resend's two variables. That was
    // wrong in both directions once Postmark became selectable: it demanded
    // RESEND_* from a Postmark deployment that would never read them, and
    // never asked for POSTMARK_API_TOKEN, which the first send would throw
    // on. The provider variable itself is the fixed part of the contract; the
    // credentials are resolved against whichever adapter is chosen. See
    // requiredProviderCredentials() and the provider-contract suite.
    expect(REQUIRED_EMAIL_ENV).toEqual(expect.arrayContaining(['EMAIL_PROVIDER']));
    expect(requiredProviderCredentials('EMAIL_PROVIDER', { EMAIL_PROVIDER: 'resend' })).toEqual([
      'RESEND_API_KEY',
      'RESEND_FROM',
    ]);
    expect(requiredProviderCredentials('EMAIL_PROVIDER', { EMAIL_PROVIDER: 'postmark' })).toEqual([
      'POSTMARK_API_TOKEN',
      'POSTMARK_FROM',
    ]);
    expect(REQUIRED_SECURITY_ENV).toEqual(
      expect.arrayContaining(['AUTH_SECRET', 'FIELD_ENCRYPTION_KEY', 'CRON_SECRET']),
    );
  });

  it('documents every required variable in .env.example', () => {
    const example = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const undocumented = [
      ...REQUIRED_SIGNUP_ENV,
      ...REQUIRED_EMAIL_ENV,
      ...REQUIRED_SECURITY_ENV,
      // Every adapter's credentials, not just the one currently selected: the
      // point of .env.example is to tell someone what they would need.
      ...Object.keys(PROVIDER_CONTRACT),
      ...Object.values(PROVIDER_CONTRACT).flatMap((c) => Object.values(c.adapters).flat()),
    ].filter((name) => !example.includes(name));
    expect(undocumented, 'required env vars missing from .env.example').toEqual([]);
  });
});

describe('missingEnv detects an unset variable — the complement path', () => {
  const KEY = 'PHASE13_CONTRACT_PROBE';
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[KEY];
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[KEY];
    else process.env[KEY] = previous;
  });

  it('reports a variable that is not set', () => {
    delete process.env[KEY];
    expect(missingEnv([KEY])).toEqual([KEY]);
  });

  it('reports a variable set to an empty string, which Vercel allows', () => {
    process.env[KEY] = '';
    expect(missingEnv([KEY])).toEqual([KEY]);
  });

  it('reports a variable set to whitespace', () => {
    process.env[KEY] = '   ';
    expect(missingEnv([KEY])).toEqual([KEY]);
  });

  it('does not report a variable with a real value', () => {
    process.env[KEY] = 'a-real-value';
    expect(missingEnv([KEY])).toEqual([]);
  });
});

describe('collectConfigMetrics counts, and only counts', () => {
  it('returns numbers, never variable names', () => {
    const metrics = collectConfigMetrics();
    for (const value of Object.values(metrics)) {
      expect(typeof value).toBe('number');
    }
    expect(JSON.stringify(metrics)).not.toContain('TURNSTILE');
  });

  it('the count rises when a required variable is removed', () => {
    const previous = process.env.TURNSTILE_EXPECTED_ACTION;
    try {
      process.env.TURNSTILE_EXPECTED_ACTION = 'signup';
      const configured = collectConfigMetrics().missingSignupEnv;
      delete process.env.TURNSTILE_EXPECTED_ACTION;
      const unconfigured = collectConfigMetrics().missingSignupEnv;
      expect(unconfigured).toBe(configured + 1);
    } finally {
      if (previous === undefined) delete process.env.TURNSTILE_EXPECTED_ACTION;
      else process.env.TURNSTILE_EXPECTED_ACTION = previous;
    }
  });
});

describe('the signup page renders the Turnstile widget without depending on the load event', () => {
  const source = readFileSync(path.join(ROOT, 'app', '(auth)', 'signup', 'SignupForm.tsx'), 'utf8');

  it('no longer renders only from the script load event', () => {
    // The exact shape of the bug: a single addEventListener('load', render)
    // with no retry. If it comes back, this fails.
    expect(source).not.toMatch(/addEventListener\(\s*['"]load['"]\s*,\s*renderWidget\s*\)/);
  });

  it('retries until window.turnstile is actually usable', () => {
    expect(source).toMatch(/setInterval/);
    expect(source).toMatch(/typeof window\.turnstile\.render !== 'function'/);
  });

  it('clears its timer on unmount so the page cannot leak an interval', () => {
    expect(source).toMatch(/clearInterval/);
    expect(source).toMatch(/cancelled = true/);
  });

  it('bounds the retry so a permanently broken script does not poll forever', () => {
    expect(source).toMatch(/attempts >= \d+/);
  });

  it('still binds the widget to the action the server verifies', () => {
    // The client action and the server's expected action have to agree or
    // every token is rejected for a different reason.
    expect(source).toMatch(/action: 'signup'/);
    const route = readFileSync(path.join(ROOT, 'app', 'api', 'onboard', 'route.ts'), 'utf8');
    expect(route).toContain('TURNSTILE_EXPECTED_ACTION');
  });
});
