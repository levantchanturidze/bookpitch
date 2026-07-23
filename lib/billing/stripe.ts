import Stripe from 'stripe';

// -----------------------------------------------------------------------------
// Single Stripe client. Env-gated so nothing crashes locally when the key
// is absent; getStripe() throws lazily if a caller actually needs it.
// -----------------------------------------------------------------------------

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  cached = new Stripe(key, {
    // API version pinning keeps Stripe from silently reshaping responses.
    // Bump deliberately as part of a Stripe upgrade PR.
    // @ts-expect-error — Stripe types lag the newest API versions.
    apiVersion: '2024-12-18.acacia',
    maxNetworkRetries: 2,
    timeout: 15_000,
  });
  return cached;
}
