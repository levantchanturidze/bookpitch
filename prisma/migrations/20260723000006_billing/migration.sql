-- SaaS subscription billing (Stripe). Kept separate from the per-appointment
-- payments table because that's per-tenant card processing (BoG/TBC), while
-- Stripe here bills the ORGANIZATION for its Bookpitch subscription.
--
-- plan          — 'free' | 'pro' | 'clinic'. Free = default on onboarding.
-- plan_status   — 'active' | 'trialing' | 'past_due' | 'canceled'.
-- stripe_customer_id / stripe_subscription_id — nullable until first upgrade.
-- current_period_end — the Stripe subscription's period boundary. When
--                      NULL or in the past, we treat the org as free.

ALTER TABLE "organizations"
    ADD COLUMN "plan"                    TEXT NOT NULL DEFAULT 'free'
        CHECK ("plan" IN ('free','pro','clinic')),
    ADD COLUMN "plan_status"             TEXT NOT NULL DEFAULT 'active'
        CHECK ("plan_status" IN ('active','trialing','past_due','canceled')),
    ADD COLUMN "stripe_customer_id"      TEXT,
    ADD COLUMN "stripe_subscription_id"  TEXT,
    ADD COLUMN "current_period_end"      TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "idx_org_stripe_customer"
    ON "organizations" ("stripe_customer_id")
    WHERE "stripe_customer_id" IS NOT NULL;

CREATE UNIQUE INDEX "idx_org_stripe_subscription"
    ON "organizations" ("stripe_subscription_id")
    WHERE "stripe_subscription_id" IS NOT NULL;
