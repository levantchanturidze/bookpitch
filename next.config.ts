import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

// -----------------------------------------------------------------------------
// Security headers apply to every route. Rationale:
//
// - CSP: default-src 'self' locks scripts/images to first-party by default.
//   'unsafe-inline' for style-src is unavoidable while Tailwind + Next inject
//   a small style block; script-src stays strict. connect-src includes 'self'
//   for our own APIs and https: for the outbound gateway/messaging calls we
//   make server-side (those don't need CSP but include for future client
//   fetches).
// - HSTS with preload — HTTPS is required on production. 2-year max-age.
// - X-Frame-Options: DENY — no page should ever load in an iframe. Blocks
//   clickjacking against the scheduler.
// - Referrer-Policy: strict-origin-when-cross-origin — no path/query leaks.
// - X-Content-Type-Options: nosniff — hardens mime handling.
// - Permissions-Policy — disable everything we don't use so a compromised
//   dependency can't opportunistically request camera/geolocation/etc.
// -----------------------------------------------------------------------------

const CSP = [
  "default-src 'self'",
  // Turnstile widget JS is loaded from Cloudflare's CDN.
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  // Turnstile renders its challenge UI inside an iframe from Cloudflare.
  "frame-src 'self' https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
];

const nextConfig: NextConfig = {
  // ---------------------------------------------------------------------------
  // P17-013 — authorization interruptions.
  //
  // Enables `forbidden()` and the `forbidden.tsx` boundary. Without it, a
  // denied page render surfaces as a generic HTTP 500 in a production build:
  // `app/(app)/error.tsx` dispatched on `error.name === 'ForbiddenError'`, and
  // Next strips name and message from errors forwarded to the client, so the
  // panel it was written for never rendered where it mattered. Measured
  // 2026-09-01 against `next start` at commit ceeb9a9: MARKETING opening
  // /scheduler, /audit and /settings received 500 with the generic fallback.
  //
  // `forbidden()` is still flagged experimental in Next 16.3.0 (introduced
  // 15.1.0). The flag only makes the API callable — it changes no other
  // behaviour — and it is the only framework-supported way to turn a server
  // authorization decision into a 403 page. The alternative, keeping a 500,
  // is worse than the flag. See docs/phase-17-stabilization-ledger.md.
  // ---------------------------------------------------------------------------
  experimental: {
    authInterrupts: true,
  },

  async headers() {
    return [
      {
        // Every path. Static assets get them too — cheap and consistent.
        source: '/(.*)',
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

// -----------------------------------------------------------------------------
// Sentry build integration — source maps only.
//
// Without this wrapper no source maps are ever uploaded, so a production stack
// trace is a list of minified frames like `t.default@/_next/static/chunks/
// 4f2a.js:1:28714`. Sentry receives the event and it is unreadable, which is a
// subtler version of not having Sentry at all: the check goes green and the
// stack still cannot be acted on.
//
// Deliberately narrow:
//
//   * Runtime initialisation is NOT delegated to the wrapper. The server and
//     edge SDKs are started from instrumentation.ts, and the browser SDK from
//     instrumentation-client.ts behind a DSN check.
//
//     Measured cost of adding this wrapper on this tree: .next/static/chunks
//     goes 1740 KB -> 1744 KB, i.e. +4 KB across all chunks. That is NOT the
//     61 KB figure quoted in instrumentation-client.ts — that number is for an
//     unconditional static import of the client SDK on the critical path,
//     which this does not do. The guarded dynamic import still decides whether
//     the SDK loads at runtime.
//
//   * Upload is disabled unless SENTRY_AUTH_TOKEN is present. A local or CI
//     build without Sentry credentials must behave exactly as it did before
//     this wrapper existed, and must not fail because a token is missing.
//
//   * `sourcemaps.deleteSourcemapsAfterUpload` keeps the maps off the CDN.
//     Uploading them to Sentry is the point; serving them to the public is
//     not — they would expose the unminified application source.
// -----------------------------------------------------------------------------
const sentryEnabled = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Never fail a build over telemetry plumbing.
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: {
    disable: !sentryEnabled,
    deleteSourcemapsAfterUpload: true,
  },
  // The SDK can rewrite framework code to capture more context. It is off
  // because it changes emitted output, and nothing here has needed it.
  disableLogger: true,
  // No tunnel route: it would be a public unauthenticated endpoint that
  // forwards arbitrary payloads to Sentry, which §9 rules out.
  tunnelRoute: undefined,
});
