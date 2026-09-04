import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isPublicPath } from '@/auth.config';

// -----------------------------------------------------------------------------
// Found by smoke-testing the DEPLOYED app, not by any test that existed.
//
// `proxy.ts` redirects every path `isPublicPath()` does not recognise to
// `/signin`. The three Sentry probe routes were never added to that list, so on
// production:
//
//   GET  /probe/sentry                      -> 307 /signin
//   POST /api/health/sentry-probe/token     -> 307 /signin
//   POST /api/health/sentry-probe           -> 307 /signin
//
// The entire Sentry verification flow was unreachable. `verify-sentry.mjs`
// would have received a redirect to the sign-in page and reported "the probe is
// disabled on this deployment", which is a sentence about the wrong thing
// entirely — and the operator would have gone looking at SENTRY_PROBE_ENABLED.
//
// Nothing local could see it. Vitest calls the handlers directly, and the
// Playwright suite runs against a build with its own routing. The proxy only
// exists in front of a deployment.
//
// This is the project's recurring shape once more, in the place it is hardest
// to see: a control that exists, is tested, and is not reachable in the path
// that actually runs.
//
// SECURITY. Being past the proxy is not being unauthenticated. Each of these
// authenticates in its own handler, and all three 404 unless
// SENTRY_PROBE_ENABLED is exactly "true":
//
//   /api/health/sentry-probe        bearer CRON_SECRET, plus a rate limit
//   /api/health/sentry-probe/token  bearer CRON_SECRET
//   /probe/sentry                   a single-use challenge in an HttpOnly
//                                   cookie, redeemed by an atomic UPDATE
//
// Exact matches only. A `startsWith('/api/health/')` would also expose
// `/api/health/ready`, which is deliberately session-gated.
// -----------------------------------------------------------------------------

describe('the Sentry probe surface is reachable past the proxy', () => {
  const PROBE_PATHS = [
    '/api/health/sentry-probe',
    '/api/health/sentry-probe/token',
    '/probe/sentry',
  ];

  for (const path of PROBE_PATHS) {
    it(`${path} is not redirected to /signin`, () => {
      expect(
        isPublicPath(path),
        `${path} is session-gated, so the probe can never run on a deployment`,
      ).toBe(true);
    });
  }

  it('COMPLEMENT: nothing else under /api/health became public', () => {
    // The fix must be three exact matches, not a prefix. `/api/health/ready`
    // is session-gated on purpose.
    for (const path of [
      '/api/health/ready',
      '/api/health/sentry-probe/anything-else',
      '/api/health/ops/extra',
      '/probe',
      '/probe/sentry/extra',
      '/probe/anything',
    ]) {
      expect(isPublicPath(path), `${path} must stay behind the proxy`).toBe(false);
    }
  });

  it('COMPLEMENT: the rest of the application is still gated', () => {
    for (const path of ['/', '/scheduler', '/settings', '/customers', '/api/customers']) {
      expect(isPublicPath(path), `${path} must stay behind the proxy`).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // §6 — the enable flag had to go, because its lifecycle made correct
  // verification impossible.
  //
  // `SENTRY_PROBE_ENABLED` is a Vercel environment variable. Changing it
  // requires a redeploy, a redeploy produces a NEW deployment id, and the soak
  // treats a new deployment id as superseded — even for the same SHA. So the
  // sequence the starter documented was:
  //
  //   enable the flag -> redeploy (deployment A) -> verify against A ->
  //   start the soak pinned to A -> turn the flag off -> redeploy (B) ->
  //   the soak is now measuring a deployment that no longer serves traffic
  //
  // The only ways out were to leave a debug switch permanently on in
  // production, or to soak a configuration nobody verified. Both are worse than
  // the flag.
  //
  // The flag was also redundant. What actually protects these routes is the
  // bearer secret and the single-use challenge; the flag added a fourth copy of
  // "and also not right now". Removing it deletes the lifecycle and leaves the
  // controls that were doing the work.
  // ---------------------------------------------------------------------------
  it('no probe route depends on a deploy-time enable flag', () => {
    for (const f of [
      'app/api/health/sentry-probe/route.ts',
      'app/api/health/sentry-probe/token/route.ts',
      'app/probe/sentry/page.tsx',
    ]) {
      const src = readFileSync(f, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
      expect(src, `${f} must not gate on SENTRY_PROBE_ENABLED`).not.toMatch(/SENTRY_PROBE_ENABLED/);
    }
  });

  it('the starter no longer asks an operator to confirm a flag', () => {
    const wf = readFileSync('.github/workflows/release-verify-and-soak.yml', 'utf8');
    expect(wf).not.toMatch(/probe_enabled_confirmed/);
  });

  it('what replaced it is a rate limit on the only unauthenticated surface', () => {
    // The page takes no bearer — it is opened by a browser — so it is the one
    // route where an attacker can spend our database. It is bounded.
    const src = readFileSync('app/probe/sentry/page.tsx', 'utf8');
    expect(src).toMatch(/redeemChallenge/);
  });

  it('the two API probe routes require the bearer secret', () => {
    for (const f of [
      'app/api/health/sentry-probe/route.ts',
      'app/api/health/sentry-probe/token/route.ts',
    ]) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} must compare a bearer against CRON_SECRET`).toMatch(
        /authorization'\) !== `Bearer \$\{secret\}`/,
      );
    }
  });
});
