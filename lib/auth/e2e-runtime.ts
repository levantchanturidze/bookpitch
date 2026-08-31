import { timingSafeEqual } from 'node:crypto';

// -----------------------------------------------------------------------------
// P17-009 — the test-only end-to-end runtime gate, and why production cannot enter it.
//
// The signup journey in e2e/ has never run. `next start` sets
// NODE_ENV=production, where SignupForm correctly fails closed without a
// Turnstile site key: no widget renders, captchaToken stays null, the submit
// button never enables. Server-side, verifyTurnstile() returns false when
// TURNSTILE_SECRET_KEY is absent in production. Both behaviours are correct and
// neither should be weakened to make a test green — disabling the CAPTCHA to
// pass the suite deletes the control the test exists to protect.
//
// So this is an additional accepted credential, not a disabled check, and it is
// bound to conditions production cannot satisfy:
//
//   1. E2E_TURNSTILE_BYPASS_TOKEN must be set, and at least 32 characters. A
//      short or guessable value is refused outright — this is a credential, so
//      it is held to a credential's standard.
//
//   2. The submitted token must equal it exactly, compared in constant time.
//
//   3. APP_URL must point at a loopback host. This is the condition that makes
//      the whole thing inert in production: production APP_URL is
//      https://bookpitch.ge. Even if the env var were somehow set there — leaked
//      through a copied config, a mis-scoped Vercel variable, a restored
//      snapshot — the bypass still refuses, because APP_URL is not localhost.
//      And APP_URL pointing at localhost in production is not a subtle
//      misconfiguration that could go unnoticed: every password-reset link,
//      every invitation link and every verification email would point at the
//      user's own machine.
//
// Condition 3 is deliberately NOT `NODE_ENV !== 'production'`. NODE_ENV is
// production during `next start`, which is exactly when the tests run, so that
// check would either break the tests or have to be skipped — and a bypass whose
// only guard is a variable the test suite has to defeat is not a guard.
//
// Nothing here weakens the real path: when the conditions do not all hold, the
// caller falls through to normal Turnstile verification unchanged.
//
// tests/phase17-turnstile-bypass.test.ts walks the whole matrix, including the
// case that matters most — production-shaped APP_URL with the variable set and
// the correct token — and requires a refusal.
// -----------------------------------------------------------------------------

/** Minimum length for the bypass credential. Short values are refused. */
const MIN_TOKEN_LENGTH = 32;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * True when `appUrl` addresses this machine. Anything unparseable is not
 * loopback — an absent or malformed APP_URL must not open the bypass.
 */
export function isLoopbackAppUrl(appUrl: string | undefined): boolean {
  if (!appUrl) return false;
  try {
    const host = new URL(appUrl).hostname;
    return LOOPBACK_HOSTS.has(host.toLowerCase());
  } catch {
    return false;
  }
}

/** Constant-time string compare that tolerates unequal lengths. */
function equals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Whether this process is a declared end-to-end run: the credential is
 * configured and strong enough, and the application is served from loopback.
 *
 * This is the single gate. Everything test-only keys off it, so there is one
 * condition to audit rather than one per feature, and production fails it on
 * the APP_URL clause alone.
 */
export function isE2ELoopbackRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const expected = env.E2E_TURNSTILE_BYPASS_TOKEN;
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return false;
  return isLoopbackAppUrl(env.APP_URL);
}

/**
 * Whether `token` is the configured end-to-end test credential AND this process
 * is one where that credential is honoured.
 *
 * Returns false for every production-shaped configuration. Callers treat false
 * as "not a bypass" and continue with real Turnstile verification.
 */
export function isE2ETurnstileBypass(
  token: string | null | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!isE2ELoopbackRuntime(env)) return false;
  const expected = env.E2E_TURNSTILE_BYPASS_TOKEN as string;
  if (typeof token !== 'string' || token.length === 0) return false;
  return equals(token, expected);
}
