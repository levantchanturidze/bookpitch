import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  issueChallenge,
  CHALLENGE_COOKIE,
  CHALLENGE_TTL_SECONDS,
} from '@/lib/sentry-probe-challenge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// -----------------------------------------------------------------------------
// POST /api/health/sentry-probe/token — mint ONE single-use authorisation for
// the browser probe page.
//
// Why a cookie and not a URL parameter. The browser probe has to be a page, and
// a page is reached by a GET. Anything in a GET URL ends up in browser history,
// in the Referer header of whatever the page loads, in access logs, and in
// whatever CI prints. The earlier design put an HMAC there — that kept
// CRON_SECRET out of the URL, but it was still a bearer credential in a URL,
// and it was replayable for its whole lifetime.
//
// So the response sets an HttpOnly, Secure, SameSite=Strict `__Host-` cookie
// carrying a challenge id. The `__Host-` prefix is not decoration: a browser
// refuses to store such a cookie unless it is Secure, path=/, and has no Domain
// attribute. Page JavaScript cannot read it, and the probe page consumes it
// server-side with an atomic UPDATE that exactly one caller can win.
//
// The nonce IS returned in the body — it is a public correlation id that ties
// the server event, the browser event and the receipt together, and the
// verifier needs it to look the events up afterwards.
//
// Same guard as the server probe: bearer CRON_SECRET, the credential every
// /api/cron/* route already uses. There is deliberately no deploy-time enable
// flag — see the comment in ../route.ts for why its lifecycle made correct
// verification impossible.
// -----------------------------------------------------------------------------

/**
 * Simplest possible in-process throttle. Honest about its limits: serverless
 * instances do not share memory, so this bounds one instance rather than the
 * deployment. It is a backstop behind the bearer secret, not the control.
 */
let lastMintAt = 0;
const MINT_MIN_INTERVAL_MS = 10_000;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // The nonce is generated HERE rather than accepted from the caller, so a
  // verification run cannot be handed one that already has matching events
  // sitting in Sentry from an earlier run.
  // Bounded, because this endpoint is now permanently reachable rather than
  // hidden behind a flag. A CRON_SECRET holder can already trigger every cron
  // job, so this is not the security boundary — it is a cap on how fast a
  // leaked secret could fill the challenge table or Sentry's quota.
  const now = Date.now();
  if (now - lastMintAt < MINT_MIN_INTERVAL_MS) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }
  lastMintAt = now;

  const challenge = await issueChallenge();

  const res = NextResponse.json(
    { nonce: challenge.nonce, expiresAt: challenge.expiresAt.toISOString() },
    // Never let an intermediary keep a copy of a Set-Cookie carrying a
    // single-use credential.
    { headers: { 'cache-control': 'no-store, max-age=0' } },
  );
  res.cookies.set({
    name: CHALLENGE_COOKIE,
    value: challenge.id,
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: CHALLENGE_TTL_SECONDS,
  });
  return res;
}
