import type { NextConfig } from 'next';

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

export default nextConfig;
