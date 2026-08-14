import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { resendPendingRegistration } from '@/lib/onboarding';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import { consumeGlobalBucket, hashForBucket, extractClientIp } from '@/lib/platform/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Resend rate limits:
//   • IP bucket  — 3 resend attempts per IP per hour
//   • Email bucket — 1 resend per email address per 5 minutes (cooldown also
//     enforced at DB level inside resendPendingRegistration)
const RESEND_IP_LIMIT = 3;
const RESEND_IP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RESEND_EMAIL_LIMIT = 1;
const RESEND_EMAIL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const MAX_BODY_BYTES = 4 * 1024;

// POST /api/onboard/resend
// { email: string }
//
// Public endpoint — no session required. Rotates the pending registration token
// and re-sends the verification email via the transactional outbox.
//
// Enumeration-safe: all outcomes return 202 { ok: true }. The caller cannot
// distinguish between "email not found", "already activated", "cooldown", or
// "resend scheduled".
export async function POST(req: NextRequest) {
  let rawBytes: Uint8Array | null = null;
  try {
    const stream = req.body;
    if (!stream) {
      rawBytes = new Uint8Array(0);
    } else {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let overflow = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > MAX_BODY_BYTES) {
              overflow = true;
              break;
            }
            chunks.push(value);
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!overflow) {
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.byteLength;
        }
        rawBytes = out;
      }
    }
  } catch {
    // Body read failure — return generic 202 (enumeration-safe).
  }
  if (rawBytes === null) return NextResponse.json({ ok: true }, { status: 202 });

  let body: { email?: unknown } | null = null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBytes));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as { email?: unknown };
    }
  } catch {
    // fall through
  }
  if (!body) return NextResponse.json({ ok: true }, { status: 202 });

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@') || email.length > 254) {
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  const ip = extractClientIp(req.headers);

  try {
    // IP rate limit.
    if (ip) {
      const ipHash = hashForBucket('resend-ip', ip);
      await consumeGlobalBucket(`resend:ip:${ipHash}`, RESEND_IP_LIMIT, RESEND_IP_WINDOW_MS);
    }
    // Per-email rate limit (complement to the DB-level cooldown).
    const emailHash = hashForBucket('resend-email', email);
    await consumeGlobalBucket(
      `resend:email:${emailHash}`,
      RESEND_EMAIL_LIMIT,
      RESEND_EMAIL_WINDOW_MS,
    );
  } catch {
    // Rate-limited — same generic 202 (enumeration-safe).
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  try {
    await resendPendingRegistration(email);
  } catch (err) {
    log.error('onboard.resend.failed', { error: sanitizeErrorMessage(err) });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
