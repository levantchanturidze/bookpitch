import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { redeemChallenge, CHALLENGE_COOKIE } from '@/lib/sentry-probe-challenge';
import { deployedReleaseSha } from '@/app/api/health/route';
import BrowserProbe from './BrowserProbe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// -----------------------------------------------------------------------------
// /probe/sentry — the page a real browser opens to prove BROWSER-side Sentry
// receipt on the deployed application.
//
// It takes NOTHING from the URL, and it has no enable flag: the only way to
// reach it is to hold a challenge that only a CRON_SECRET holder can mint, and
// each one works exactly once. A flag would have added a fourth copy of "and
// also not right now" while forcing a redeploy that breaks soak identity.
//
// Authorisation is a single-use challenge id in
// an HttpOnly `__Host-` cookie, redeemed here with an atomic UPDATE: the first
// request to arrive wins, every later one gets the same 404 as an unauthorised
// visitor. Reloading this page does not re-run the probe — it 404s, which is
// the visible consequence of "single-use" being a property rather than a label.
//
// A bad or spent challenge gets the same 404 as a disabled probe, so the route
// reveals nothing about itself.
// -----------------------------------------------------------------------------

export const metadata = { robots: { index: false, follow: false, nocache: true } };

export default async function SentryProbePage() {
  const jar = await cookies();
  const nonce = await redeemChallenge(jar.get(CHALLENGE_COOKIE)?.value);
  // Deliberately does not say WHICH check failed: unknown, spent and expired
  // are indistinguishable to a caller who should not be here.
  if (!nonce) notFound();

  return <BrowserProbe nonce={nonce} release={deployedReleaseSha() || null} />;
}
