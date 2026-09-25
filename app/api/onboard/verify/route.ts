import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { activatePendingRegistration } from '@/lib/onboarding';
import { InvalidInputError } from '@/lib/auth';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import { consumeGlobalBucket, hashForBucket, extractClientIp } from '@/lib/platform/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Verification rate limit: 10 attempts per IP per 5 minutes.
// Prevents brute-forcing the 256-bit token space (already computationally
// infeasible, but defense-in-depth).
const VERIFY_LIMIT = 10;
const VERIFY_WINDOW_MS = 5 * 60 * 1000;

// GET /api/onboard/verify?token=<hex>
//
// Atomically consumes a pending registration token and activates the account.
// Redirects to /onboard/success on success, /onboard/expired on failure.
//
// Security properties:
//   • Token is 256-bit random (32 bytes hex = 64 chars); brute force infeasible.
//   • Only the SHA-256 hash is stored in the DB; raw token is never stored.
//   • DELETE ... WHERE token_hash = ? AND expires_at > now() is atomic.
//   • Rate limited per IP: 10 attempts per 5 minutes.
//   • Referrer-Policy: no-referrer prevents token from leaking in HTTP referer.
//   • no-cache prevents token URL from being stored in browser/CDN cache.
//   • Redirect rather than returning the token in a JSON body so it doesn't
//     appear in fetch() response logs or API-level analytics.
// Phase timings for the 2026-09-25T20:00:03Z anomaly.
//
// On that request the activation COMMITTED (pending row consumed, org + user +
// location created at 20:00:03.794Z) and no HTTP response ever arrived — the
// client gave up at 120 s having received zero bytes. `/api/health`, which
// touches no database, answered in 1.3 s during the same window, while
// `/signin` timed out at 30 s; everything was sub-second minutes later.
//
// The activation itself is bounded: withoutRls() uses Prisma's default
// interactive-transaction timeout of 5 s, so ~113 s could not have been spent
// inside it. That leaves the phases either side — connection acquisition and
// the pre-transaction rate-limit write — and nothing in the log said which,
// because nothing here was timed.
//
// This does not fix the stall. It makes the next occurrence diagnosable
// instead of inferable, which is the difference between an anomaly and an
// investigation.
const SLOW_PHASE_MS = Number(process.env.LATENCY_WARN_MS ?? 1000);

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const marks: Record<string, number> = {};
  const mark = (phase: string) => {
    marks[phase] = Date.now() - startedAt;
  };
  const ip = extractClientIp(req.headers);

  const appUrl = process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? '';

  const headers = {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Referrer-Policy': 'no-referrer',
  };

  try {
    // Rate limit before touching the token. Hash the IP so PII is not stored
    // in plaintext in platform_rate_limit. Skip when no IP header is present
    // (direct calls in tests / local dev — proxy always sets this in production).
    if (ip) {
      const ipHash = hashForBucket('verify-ip', ip);
      // First DB call of the request: on a cold instance this is also where the
      // Prisma engine initialises and the pooled connection is acquired.
      await consumeGlobalBucket(`verify:ip:${ipHash}`, VERIFY_LIMIT, VERIFY_WINDOW_MS);
    }
    mark('rateLimitMs');

    const token = new URL(req.url).searchParams.get('token') ?? '';

    await activatePendingRegistration(token);
    mark('activateMs');

    // Redirect to a success page. The token is not included in the redirect URL.
    const successUrl = appUrl ? `${appUrl}/onboard/success` : '/onboard/success';
    const totalMs = Date.now() - startedAt;
    // Always emit the breakdown on success — an activation is rare and the
    // timing is the only record of how long the user actually waited.
    const line = { ...marks, totalMs, outcome: 'activated' };
    if (totalMs >= SLOW_PHASE_MS) log.warn('onboard.verify_slow', line);
    else log.info('onboard.verify_timing', line);
    return NextResponse.redirect(successUrl, { headers });
  } catch (err) {
    if (err instanceof InvalidInputError) {
      const expiredUrl = appUrl ? `${appUrl}/onboard/expired` : '/onboard/expired';
      const totalMs = Date.now() - startedAt;
      if (totalMs >= SLOW_PHASE_MS) {
        log.warn('onboard.verify_slow', { ...marks, totalMs, outcome: 'rejected' });
      }
      return NextResponse.redirect(expiredUrl, { headers });
    }
    log.error('onboard.verify_failed', {
      ...marks,
      totalMs: Date.now() - startedAt,
      error: sanitizeErrorMessage(err),
    });
    const errorUrl = appUrl ? `${appUrl}/onboard/error` : '/onboard/error';
    return NextResponse.redirect(errorUrl, { headers });
  }
}
