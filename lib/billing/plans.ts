// -----------------------------------------------------------------------------
// Plan definitions and entitlement helpers. Plan tiers are hard-coded here
// because the underlying resource limits (staff seats, monthly assistant
// calls, message volume) map 1:1 to features in the code — leaving them as
// data in Postgres would only add indirection.
//
// Stripe price IDs are injected via env so the same code deploys to test
// mode + live mode.
// -----------------------------------------------------------------------------

export type PlanId = 'free' | 'pro' | 'clinic';

export type Plan = {
  id: PlanId;
  name: string;
  monthlyPriceGel: number;
  stripePriceId: string | undefined; // undefined for the free tier
  entitlements: {
    maxStaff: number;
    maxMonthlyAssistantCalls: number;
    smsRemindersEnabled: boolean;
    analyticsEnabled: boolean;
  };
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyPriceGel: 0,
    stripePriceId: undefined,
    entitlements: {
      maxStaff: 2,
      maxMonthlyAssistantCalls: 50,
      smsRemindersEnabled: false,
      analyticsEnabled: false,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    monthlyPriceGel: 49,
    stripePriceId: process.env.STRIPE_PRICE_ID_PRO,
    entitlements: {
      maxStaff: 8,
      maxMonthlyAssistantCalls: 500,
      smsRemindersEnabled: true,
      analyticsEnabled: false,
    },
  },
  clinic: {
    id: 'clinic',
    name: 'Clinic',
    monthlyPriceGel: 149,
    stripePriceId: process.env.STRIPE_PRICE_ID_CLINIC,
    entitlements: {
      maxStaff: 50,
      maxMonthlyAssistantCalls: 5000,
      smsRemindersEnabled: true,
      analyticsEnabled: true,
    },
  },
};

export function planFromId(id: string | undefined | null): Plan {
  if (id && (id === 'free' || id === 'pro' || id === 'clinic')) return PLANS[id];
  return PLANS.free;
}

export type BillingSnapshot = {
  plan: PlanId;
  planStatus: 'active' | 'trialing' | 'past_due' | 'canceled';
  currentPeriodEnd: Date | null;
};

/**
 * Effective plan for an org considering status. past_due keeps the plan
 * active for a grace period (we let the caller decide by returning the
 * paid plan); canceled after the period end drops to free.
 */
export function effectivePlan(snap: BillingSnapshot, now: Date = new Date()): Plan {
  const paid = planFromId(snap.plan);
  if (paid.id === 'free') return PLANS.free;
  if (snap.planStatus === 'canceled') {
    if (snap.currentPeriodEnd && snap.currentPeriodEnd.getTime() > now.getTime()) {
      return paid; // canceled but not yet expired
    }
    return PLANS.free;
  }
  // active | trialing | past_due — grant the paid tier. Downgrade is a
  // Stripe webhook away.
  return paid;
}
