import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { log } from '@/lib/logger';
import { deployedReleaseSha } from '@/app/api/health/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// -----------------------------------------------------------------------------
// POST /api/health/sentry-probe — make the DEPLOYED application emit one real
// Sentry event, so receipt can be proven rather than asserted.
//
// Why an endpoint at all. scripts/verify-sentry.mjs previously posted a
// synthetic envelope from a laptop through the Node SDK. That proves Sentry's
// ingest accepts a well-formed request; it proves nothing about whether THIS
// deployment is configured, whether its DSN works, or whether its stack frames
// resolve — the event had no production exception and no stack at all.
//
// SAFETY, because a "throw an error" endpoint is exactly what should not be
// public:
//
//   * bearer CRON_SECRET, the same credential the cron endpoints use, so it is
//     reachable only from a workflow that already holds it;
//   * off unless SENTRY_PROBE_ENABLED is exactly "true", so it cannot be
//     reached at all on a deployment that has not deliberately turned it on;
//   * a caller-supplied nonce is required and echoed into the event, so a
//     verification run can prove the event is its own and not a cached one;
//   * in-process rate limit — one probe per minute. Honest about its limits:
//     serverless instances do not share memory, so this bounds a single
//     instance rather than the deployment. It is a backstop behind the enable
//     flag and the bearer secret, not the primary control;
//   * no PII, no request data, no stack from the caller. The error is
//     constructed here, in this file, and its stack is this file.
//
// It is NOT a debugging endpoint: it takes no payload beyond the nonce and
// returns only an event id.
// -----------------------------------------------------------------------------

/** Simplest possible in-process throttle. One probe per minute is ample. */
let lastProbeAt = 0;
const PROBE_MIN_INTERVAL_MS = 60_000;

/** Deliberately named so it is obvious in Sentry that this is synthetic. */
class BookpitchSentryProbeError extends Error {
  constructor(nonce: string) {
    super(`Bookpitch synthetic Sentry probe (${nonce}) — safe to resolve`);
    this.name = 'BookpitchSentryProbeError';
  }
}

export async function POST(req: NextRequest) {
  if (process.env.SENTRY_PROBE_ENABLED !== 'true') {
    // 404 rather than 403: a disabled probe should not advertise that it exists.
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const now = Date.now();
  if (now - lastProbeAt < PROBE_MIN_INTERVAL_MS) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }
  lastProbeAt = now;

  let nonce: string;
  try {
    const body = (await req.json()) as { nonce?: unknown };
    nonce = typeof body?.nonce === 'string' ? body.nonce : '';
  } catch {
    nonce = '';
  }
  // Bounded and character-restricted: it is echoed into a Sentry tag.
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) {
    return NextResponse.json(
      { error: 'a nonce of 8-64 [A-Za-z0-9_-] is required' },
      { status: 400 },
    );
  }

  if (!process.env.SENTRY_DSN) {
    // Honest rather than silently successful: without a DSN Sentry.init() never
    // ran and captureException is a no-op that still returns an id.
    return NextResponse.json({ error: 'SENTRY_DSN is not configured' }, { status: 503 });
  }

  const release = deployedReleaseSha();
  const eventId = Sentry.captureException(new BookpitchSentryProbeError(nonce), {
    tags: {
      bookpitch_verification_nonce: nonce,
      bookpitch_runtime: 'server',
      bookpitch_probe: 'true',
    },
    ...(release ? { extra: { release } } : {}),
  });
  // Serverless: the process may freeze the moment the response is returned, so
  // the transport has to drain first or the event never leaves.
  const flushed = await Sentry.flush(8_000);

  log.info('sentry_probe.emitted', { nonce, flushed });
  return NextResponse.json({ ok: true, eventId, flushed, release: release || null });
}
