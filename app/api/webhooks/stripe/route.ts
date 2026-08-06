import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/billing/stripe';
import { applySubscriptionEvent } from '@/lib/billing/service';
import { log, sanitizeErrorMessage } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/webhooks/stripe
//
// Public — authenticated by the Stripe-Signature header verified against
// STRIPE_WEBHOOK_SECRET. Never trust the payload if the sig doesn't
// verify: return 401 immediately.
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'STRIPE_WEBHOOK_SECRET not set' }, { status: 500 });
  const sig = req.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'missing stripe-signature' }, { status: 401 });

  const stripe = getStripe();
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    log.warn('stripe.webhook.signature_invalid', { error: sanitizeErrorMessage(err) });
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      // The subscription may be present already; if so we apply immediately.
      // Otherwise wait for customer.subscription.created / .updated below.
      const s = event.data.object;
      if (s.subscription) {
        const sub = await stripe.subscriptions.retrieve(s.subscription as string);
        await applySubscriptionEvent(sub);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      await applySubscriptionEvent(event.data.object);
      break;
    }
    default:
      // Everything else (invoice.paid, payment_failed, …) is fine to no-op
      // for MVP; the subscription events already carry the plan status.
      break;
  }
  return NextResponse.json({ received: true });
}
