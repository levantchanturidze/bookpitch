import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createPendingRegistration } from '@/lib/onboarding';
import { InvalidInputError } from '@/lib/auth';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import { consumeGlobalBucket, hashForBucket } from '@/lib/platform/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Body size guard — reject payloads over 16 KB before parsing.
const MAX_BODY_BYTES = 16 * 1024;

// Onboard rate limit: 5 new signup attempts per IP per hour.
const ONBOARD_LIMIT = 5;
const ONBOARD_WINDOW_MS = 60 * 60 * 1000;

// Verification token TTL: 24 hours.
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

type TurnstileResponse = {
  success: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
  challenge_ts?: string;
};

/**
 * Verify a Cloudflare Turnstile CAPTCHA token.
 *
 * Validates:
 *   • success === true
 *   • action matches TURNSTILE_EXPECTED_ACTION (if configured)
 *   • hostname is in TURNSTILE_ALLOWED_HOSTNAMES (if configured)
 *
 * Skipped when TURNSTILE_SECRET_KEY is absent (dev/test). Fails closed in
 * production on network error. The expected action and hostname are read
 * from env vars — never from the client request body.
 */
async function verifyTurnstile(token: string | null, ip: string | null): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured — skip in dev/test

  if (!token) return false;

  const form = new URLSearchParams();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);

  const isProduction = process.env.NODE_ENV === 'production';

  let data: TurnstileResponse;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: controller.signal,
      });
      data = (await res.json()) as TurnstileResponse;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Network error / timeout: fail closed in production to preserve bot
    // protection; fall open in non-production so engineers can test signup.
    log.warn('onboard.turnstile_check_failed', { failedClosed: isProduction });
    return !isProduction;
  }

  if (data.success !== true) {
    log.info('onboard.turnstile_rejected', { codes: data['error-codes'] });
    return false;
  }

  // Action binding — prevents token reuse across different widget placements.
  const expectedAction = process.env.TURNSTILE_EXPECTED_ACTION;
  if (expectedAction && data.action !== expectedAction) {
    log.warn('onboard.turnstile_action_mismatch', {});
    return false;
  }

  // Hostname binding — prevents token reuse from an attacker-controlled domain.
  const allowedHostnames = process.env.TURNSTILE_ALLOWED_HOSTNAMES;
  if (allowedHostnames) {
    const allowed = new Set(
      allowedHostnames
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
    );
    if (!allowed.has(data.hostname ?? '')) {
      log.warn('onboard.turnstile_hostname_mismatch', {});
      return false;
    }
  }

  return true;
}

// POST /api/onboard
// { email, password, fullName, orgName, locationName?, locationType?, turnstileToken? }
//
// Public endpoint — no session. Creates a pending registration and sends a
// verification email. The org + user are NOT created until the verification
// link is clicked. This prevents unverified emails from operating as tenants.
//
// Returns generic 400 for all validation failures (enumeration-safe).
export async function POST(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    null;

  try {
    if (ip) {
      const ipHash = hashForBucket('onboard-ip', ip);
      await consumeGlobalBucket(`onboard:ip:${ipHash}`, ONBOARD_LIMIT, ONBOARD_WINDOW_MS);
    }

    const turnstileToken = typeof body.turnstileToken === 'string' ? body.turnstileToken : null;
    const captchaOk = await verifyTurnstile(turnstileToken, ip);
    if (!captchaOk) {
      return NextResponse.json({ error: 'invalid request' }, { status: 400 });
    }

    await createPendingRegistration({
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
      fullName: String(body.fullName ?? ''),
      orgName: String(body.orgName ?? ''),
      locationName: body.locationName ? String(body.locationName) : undefined,
      locationType: (body.locationType as 'clinic' | 'salon' | undefined) ?? undefined,
      tokenTtlMs: TOKEN_TTL_MS,
    });

    // Generic success: same response whether the email is new or duplicate
    // to prevent enumeration ("does this email exist?").
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (err) {
    if (err instanceof InvalidInputError) {
      return NextResponse.json({ error: 'invalid request' }, { status: 400 });
    }
    log.error('onboard.failed', { error: sanitizeErrorMessage(err) });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
