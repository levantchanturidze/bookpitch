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
// It takes NOTHING from the URL. Authorisation is a single-use challenge id in
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
  if (process.env.SENTRY_PROBE_ENABLED !== 'true') notFound();

  const jar = await cookies();
  const nonce = await redeemChallenge(jar.get(CHALLENGE_COOKIE)?.value);
  // Deliberately does not say WHICH check failed: unknown, spent and expired
  // are indistinguishable to a caller who should not be here.
  if (!nonce) notFound();

  return <BrowserProbe nonce={nonce} release={deployedReleaseSha() || null} />;
}
