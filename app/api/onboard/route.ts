import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createPendingRegistration } from '@/lib/onboarding';
import { InvalidInputError } from '@/lib/auth';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import { consumeGlobalBucket, hashForBucket, extractClientIp } from '@/lib/platform/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Maximum body size. Enforced by consuming the stream up to this limit —
// Content-Length alone is falsifiable by a chunked or malformed request.
const MAX_BODY_BYTES = 16 * 1024;

// Read the request body up to maxBytes. Returns null when the body exceeds
// the limit — caller should respond 413. Counts actual bytes received, not
// the Content-Length header (which an attacker can falsify on chunked requests).
// Cancels the underlying stream on overflow so the connection is not held open.
async function readBodyLimited(
  req: NextRequest,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; tooLarge: boolean }> {
  const stream = req.body;
  if (!stream) return { ok: true, bytes: new Uint8Array(0) };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          // Cancel the stream so the connection is not held open awaiting the rest.
          reader.cancel().catch(() => {});
          return { ok: false, tooLarge: true };
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: out };
}

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
  if (!secret) {
    // No key configured. In production this is a misconfiguration — fail closed
    // so the endpoint can't be abused without bot protection.
    // In dev/test, allow without challenge.
    if (process.env.NODE_ENV === 'production') {
      log.error('onboard.turnstile_secret_missing', {});
      return false;
    }
    return true;
  }

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

  // In production the action and hostname allowlist are mandatory — a missing
  // env var means the widget was not configured for binding and the token can
  // be replayed across placements or attacker-controlled origins.
  const expectedAction = process.env.TURNSTILE_EXPECTED_ACTION;
  if (isProduction && !expectedAction) {
    log.error('onboard.turnstile_action_env_missing', {});
    return false;
  }
  if (expectedAction && data.action !== expectedAction) {
    log.warn('onboard.turnstile_action_mismatch', {});
    return false;
  }

  // Hostname binding — prevents token reuse from an attacker-controlled domain.
  const allowedHostnames = process.env.TURNSTILE_ALLOWED_HOSTNAMES;
  if (isProduction && !allowedHostnames) {
    log.error('onboard.turnstile_hostname_env_missing', {});
    return false;
  }
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

  // Challenge age — reject tokens older than 5 minutes to prevent replay.
  // In production this check is strict: absent challenge_ts is treated as expired.
  if (!data.challenge_ts) {
    if (isProduction) {
      log.warn('onboard.turnstile_challenge_ts_missing', {});
      return false;
    }
  } else {
    const challengeAge = Date.now() - new Date(data.challenge_ts).getTime();
    const maxAgeMs = 5 * 60 * 1000;
    if (challengeAge > maxAgeMs) {
      log.warn('onboard.turnstile_challenge_expired', {});
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
  const bodyResult = await readBodyLimited(req, MAX_BODY_BYTES);
  if (!bodyResult.ok) {
    return NextResponse.json({ error: 'request too large' }, { status: 413 });
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bodyResult.bytes));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const ip = extractClientIp(req.headers);

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
