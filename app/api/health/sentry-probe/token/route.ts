import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { generateProbeNonce, issueProbeToken } from '@/lib/sentry-probe-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// -----------------------------------------------------------------------------
// POST /api/health/sentry-probe/token — mint one short-lived authorisation for
// the BROWSER probe page.
//
// Why this exists. Sentry receipt has to be proven for two runtimes, and the
// browser one cannot be proven from a script: `@sentry/nextjs` in the browser
// is a different SDK, a different DSN, a different transport and a different
// source-map upload. The only honest proof is a real browser loading a real
// page on the deployed app.
//
// That page throws on purpose, so it needs authorisation — and CRON_SECRET
// cannot be the credential, because the page is a URL a browser navigates to
// and a URL ends up in logs, history and referrers. This endpoint holds the
// secret and hands back something derived from it: an HMAC over one nonce and
// a five-minute expiry (lib/sentry-probe-token.ts).
//
// Same guards as the server probe: off unless SENTRY_PROBE_ENABLED is exactly
// "true", 404 rather than 403 when off, bearer CRON_SECRET otherwise.
// -----------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  if (process.env.SENTRY_PROBE_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // The nonce is generated HERE rather than accepted from the caller, so a
  // verification run cannot be handed a nonce that already has matching events
  // sitting in Sentry from an earlier run.
  const issued = issueProbeToken(secret, generateProbeNonce());
  return NextResponse.json(issued, {
    // Belt and braces: never let an intermediary keep a copy.
    headers: { 'cache-control': 'no-store, max-age=0' },
  });
}
