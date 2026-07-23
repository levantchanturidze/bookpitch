import type Stripe from 'stripe';
import { withOrg, withoutRls } from '@/lib/db';
import { InvalidInputError, type ActiveSession } from '@/lib/auth';
import { PLANS, effectivePlan, planFromId, type PlanId } from './plans';
import { getStripe } from './stripe';
import { log } from '@/lib/logger';

// -----------------------------------------------------------------------------
// Billing service. Two public surfaces:
//   - startCheckout(session, planId) → { url } for the client to redirect to.
//   - handleStripeWebhook(rawBody, sig) → updates the Organization row.
// The rest is env + helpers.
// -----------------------------------------------------------------------------

export async function getBilling(session: ActiveSession) {
  const org = await withOrg(session.organizationId, (tx) =>
    tx.organization.findUniqueOrThrow({
      where: { id: session.organizationId },
      select: {
        id: true,
        name: true,
        plan: true,
        planStatus: true,
        currentPeriodEnd: true,
      },
    }),
  );
  return {
    org,
    effective: effectivePlan({
      plan: org.plan as PlanId,
      planStatus: org.planStatus as
        | 'active'
        | 'trialing'
        | 'past_due'
        | 'canceled',
      currentPeriodEnd: org.currentPeriodEnd,
    }),
    plans: PLANS,
  };
}

export async function startCheckout(
  session: ActiveSession,
  planId: PlanId,
): Promise<{ url: string }> {
  if (session.role !== 'owner') {
    throw new InvalidInputError('only owners can change the plan');
  }
  const plan = planFromId(planId);
  if (plan.id === 'free') throw new InvalidInputError('free is not a checkoutable plan');
  if (!plan.stripePriceId) {
    throw new InvalidInputError(`STRIPE_PRICE_ID for ${plan.id} is not configured`);
  }
  const stripe = getStripe();
  const origin = process.env.APP_URL ?? 'http://localhost:3000';

  // Reuse an existing Stripe customer for this org if we have one.
  const org = await withOrg(session.organizationId, (tx) =>
    tx.organization.findUniqueOrThrow({
      where: { id: session.organizationId },
      select: { id: true, name: true, stripeCustomerId: true },
    }),
  );
  let customerId = org.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: session.email,
      name: org.name,
      metadata: { organizationId: org.id },
    });
    customerId = customer.id;
    await withOrg(session.organizationId, (tx) =>
      tx.organization.update({
        where: { id: session.organizationId },
        data: { stripeCustomerId: customer.id },
      }),
    );
  }

  const sessionResp = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: `${origin}/settings/billing?checkout=ok`,
    cancel_url: `${origin}/settings/billing?checkout=cancel`,
    // Pin the org so the webhook can look us up even if metadata gets stripped
    // upstream.
    client_reference_id: session.organizationId,
    subscription_data: { metadata: { organizationId: session.organizationId } },
  });

  if (!sessionResp.url) throw new Error('Stripe returned a session without a URL');
  return { url: sessionResp.url };
}

// Applies a Stripe subscription event to the Organization row. Idempotent —
// same event landing twice is a no-op past the first apply.
export async function applySubscriptionEvent(
  subscription: Stripe.Subscription,
): Promise<void> {
  const orgId =
    (subscription.metadata?.organizationId as string | undefined) ??
    ((subscription.customer as string | undefined) ? await lookupOrgByCustomer(
      subscription.customer as string,
    ) : undefined);
  if (!orgId) {
    log.warn('billing.subscription.no_org', { subscriptionId: subscription.id });
    return;
  }

  // Map Stripe price → our plan id. If we don't recognise the price we
  // fall back to leaving plan unchanged and log — signals a misconfigured
  // Stripe product.
  const firstItem = subscription.items.data[0];
  const priceId = firstItem?.price.id;
  const planId = matchPriceToPlan(priceId);
  const status = mapStripeStatus(subscription.status);
  // Stripe moved current_period_end onto individual subscription items in
  // a recent API version; fall back to the top-level field on older payloads.
  const periodEndEpoch =
    (firstItem as { current_period_end?: number } | undefined)?.current_period_end ??
    (subscription as unknown as { current_period_end?: number }).current_period_end ??
    0;
  const currentPeriodEnd = periodEndEpoch ? new Date(periodEndEpoch * 1000) : null;

  await withoutRls((tx) =>
    tx.organization.update({
      where: { id: orgId },
      data: {
        stripeSubscriptionId: subscription.id,
        planStatus: status,
        currentPeriodEnd,
        ...(planId ? { plan: planId } : {}),
      },
    }),
  );
  log.info('billing.subscription.applied', {
    organizationId: orgId,
    status,
    plan: planId ?? '<unchanged>',
  });
}

async function lookupOrgByCustomer(stripeCustomerId: string): Promise<string | undefined> {
  const org = await withoutRls((tx) =>
    tx.organization.findFirst({
      where: { stripeCustomerId },
      select: { id: true },
    }),
  );
  return org?.id;
}

function matchPriceToPlan(priceId: string | undefined): PlanId | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_ID_PRO) return 'pro';
  if (priceId === process.env.STRIPE_PRICE_ID_CLINIC) return 'clinic';
  return null;
}

function mapStripeStatus(s: Stripe.Subscription.Status): 'active' | 'trialing' | 'past_due' | 'canceled' {
  switch (s) {
    case 'active':
    case 'trialing':
    case 'past_due':
    case 'canceled':
      return s;
    case 'unpaid':
      return 'past_due';
    case 'incomplete':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'canceled';
  }
}
