import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { onboardOrg } from '@/lib/onboarding';
import { InvalidInputError } from '@/lib/auth';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import { consumeGlobalBucket } from '@/lib/platform/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Body size guard — reject payloads over 16 KB before parsing.
const MAX_BODY_BYTES = 16 * 1024;

// Onboard rate limit: 5 new signups per IP per hour.
const ONBOARD_LIMIT = 5;
const ONBOARD_WINDOW_MS = 60 * 60 * 1000;

/**
 * Verify a Cloudflare Turnstile CAPTCHA token when TURNSTILE_SECRET_KEY
 * is configured. Skipped in dev/test (env var absent). Returns true if
 * the token is valid or if Turnstile is not configured.
 */
async function verifyTurnstile(token: string | null, ip: string | null): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured — skip

  if (!token) return false;

  const form = new URLSearchParams();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = (await res.json()) as { success: boolean };
    return data.success === true;
  } catch {
    // Turnstile outage: fail open (best-effort) so signup still works.
    // Rate limiting still applies.
    log.warn('onboard.turnstile_check_failed');
    return true;
  }
}

// POST /api/onboard
// { email, password, fullName, orgName, locationName?, locationType?, turnstileToken? }
//
// Public — no session (that's the whole point). Creates the org + owner
// in one transaction and returns identifiers. The caller then hits
// /signin with the same credentials.
export async function POST(req: NextRequest) {
  // Body size guard — avoids JSON parsing of huge payloads.
  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? null;

  try {
    // Rate limit by IP before any DB work.
    if (ip) {
      await consumeGlobalBucket(`onboard:ip:${ip}`, ONBOARD_LIMIT, ONBOARD_WINDOW_MS);
    }

    // CAPTCHA check (optional — only active when TURNSTILE_SECRET_KEY is set).
    const turnstileToken = typeof body.turnstileToken === 'string' ? body.turnstileToken : null;
    const captchaOk = await verifyTurnstile(turnstileToken, ip);
    if (!captchaOk) {
      // Generic 400 — don't distinguish "missing token" from "invalid token"
      // to avoid giving bots a path to bypass.
      return NextResponse.json({ error: 'invalid request' }, { status: 400 });
    }

    const result = await onboardOrg({
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
      fullName: String(body.fullName ?? ''),
      orgName: String(body.orgName ?? ''),
      locationName: body.locationName ? String(body.locationName) : undefined,
      locationType: (body.locationType as 'clinic' | 'salon' | undefined) ?? undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidInputError) {
      // Return a generic error for validation failures to prevent email
      // enumeration (the caller cannot distinguish "email taken" from
      // "invalid password" from the response body).
      return NextResponse.json({ error: 'invalid request' }, { status: 400 });
    }
    log.error('onboard.failed', { error: sanitizeErrorMessage(err) });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
