import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { activatePendingRegistration } from '@/lib/onboarding';
import { InvalidInputError } from '@/lib/auth';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import { consumeGlobalBucket } from '@/lib/platform/rate-limit';

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
export async function GET(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown';

  const appUrl = process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? '';

  const headers = {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Referrer-Policy': 'no-referrer',
  };

  try {
    // Rate limit before touching the token.
    await consumeGlobalBucket(`verify:ip:${ip}`, VERIFY_LIMIT, VERIFY_WINDOW_MS);

    const token = req.nextUrl.searchParams.get('token') ?? '';

    await activatePendingRegistration(token);

    // Redirect to a success page. The token is not included in the redirect URL.
    const successUrl = appUrl ? `${appUrl}/onboard/success` : '/onboard/success';
    return NextResponse.redirect(successUrl, { headers });
  } catch (err) {
    if (err instanceof InvalidInputError) {
      const expiredUrl = appUrl ? `${appUrl}/onboard/expired` : '/onboard/expired';
      return NextResponse.redirect(expiredUrl, { headers });
    }
    log.error('onboard.verify_failed', { error: sanitizeErrorMessage(err) });
    const errorUrl = appUrl ? `${appUrl}/onboard/error` : '/onboard/error';
    return NextResponse.redirect(errorUrl, { headers });
  }
}
