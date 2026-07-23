-- Web Push subscriptions. One row per (user, device) pair. The three
-- {endpoint, p256dh, auth} strings are what the browser gives us via
-- PushManager.subscribe; we hand them straight back to web-push at send
-- time.
--
-- Scoped per user (not per org) — a user with memberships in multiple
-- orgs still gets one device subscription and receives events for
-- whichever org is active in their session.

CREATE TABLE "push_subscription" (
    "id"          UUID           NOT NULL DEFAULT gen_random_uuid(),
    "user_id"     UUID           NOT NULL,
    "endpoint"    TEXT           NOT NULL,
    "p256dh"      TEXT           NOT NULL,
    "auth"        TEXT           NOT NULL,
    "user_agent"  TEXT,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    CONSTRAINT "push_subscription_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_subscription_endpoint_unique" UNIQUE ("endpoint"),
    CONSTRAINT "push_subscription_user_fk"
        FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE
);
CREATE INDEX "idx_push_subscription_user" ON "push_subscription" ("user_id");

-- NOT tenant-scoped: app_users itself has no RLS (auth predates org
-- context; see the note in the initial RLS migration). The endpoint is
-- opaque + guessing an endpoint yields nothing useful — the browser's
-- push service authenticates on the endpoint URL.
GRANT SELECT, INSERT, UPDATE, DELETE ON "push_subscription" TO bookpitch_app;
