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

  it('every probe route refuses when the probe is disabled', () => {
    // Being public is only acceptable because each handler fails closed. This
    // asserts the guard is present in each file rather than trusting the
    // comment above.
    for (const f of [
      'app/api/health/sentry-probe/route.ts',
      'app/api/health/sentry-probe/token/route.ts',
      'app/probe/sentry/page.tsx',
    ]) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} must check SENTRY_PROBE_ENABLED`).toMatch(
        /process\.env\.SENTRY_PROBE_ENABLED !== 'true'/,
      );
    }
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
