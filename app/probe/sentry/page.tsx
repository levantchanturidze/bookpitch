import { notFound } from 'next/navigation';
import { verifyProbeToken } from '@/lib/sentry-probe-token';
import { deployedReleaseSha } from '@/app/api/health/route';
import BrowserProbe from './BrowserProbe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// -----------------------------------------------------------------------------
// /probe/sentry — the page a real browser opens to prove BROWSER-side Sentry
// receipt on the deployed application.
//
// Authorisation is checked on the server, before any client component is sent:
// a bad token gets the same 404 as a disabled probe, so the route reveals
// nothing about itself. The nonce reaches the browser (it is a public
// correlation id and has to be in the event); the secret never does.
//
// `robots` and `X-Robots-Tag` keep it out of indexes for the minutes it exists.
// -----------------------------------------------------------------------------

export const metadata = { robots: { index: false, follow: false, nocache: true } };

export default async function SentryProbePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.SENTRY_PROBE_ENABLED !== 'true') notFound();

  const secret = process.env.CRON_SECRET;
  if (!secret) notFound();

  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);
  const nonce = one('nonce');
  const verdict = verifyProbeToken(secret, {
    nonce,
    token: one('token'),
    expiresAt: Number(one('exp')),
  });
  // Deliberately does not say WHICH check failed: an unauthorised caller learns
  // only that there is nothing here.
  if (!verdict.ok) notFound();

  return <BrowserProbe nonce={nonce as string} release={deployedReleaseSha() || null} />;
}
