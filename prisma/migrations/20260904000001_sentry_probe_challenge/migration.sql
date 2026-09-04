-- Single-use challenges for the browser Sentry probe.
--
-- The browser half of Sentry verification needs a page a real browser can open
-- on the deployed app, and that page deliberately throws. It therefore needs
-- authorisation — but a browser navigation is a GET, and anything in a GET URL
-- ends up in history, in referrers, in access logs and in whatever the CI
-- runner prints.
--
-- The first design put an HMAC and its expiry in the query string. That kept
-- CRON_SECRET out of the URL, which was the point, but the token itself was
-- still a bearer credential sitting in a URL, and it was replayable for its
-- whole five-minute lifetime. Calling that "one-time" would have been a claim,
-- not a property.
--
-- This table makes it a property. A challenge is a row; consuming it is
--
--   UPDATE ... SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL
--
-- which exactly one caller can win, decided by PostgreSQL rather than by
-- application logic. Expiry is `expires_at > NOW()` — the database clock, for
-- the same reason every other deadline in this schema is.
--
-- The id travels in an HttpOnly, Secure, SameSite=Strict cookie, so it is not
-- in the URL, not in history, not in a referrer, and not readable by page
-- JavaScript.
--
-- Rollback: DROP TABLE public.sentry_probe_challenge;
--   Safe at any time. Nothing else references it, it holds no customer data,
--   and losing it only means the browser probe cannot run until it is
--   recreated.

CREATE TABLE public.sentry_probe_challenge (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The public correlation id echoed into the Sentry event. Not a secret.
    nonce       text        NOT NULL,
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT NOW()
);

-- Finding a live challenge, and sweeping dead ones, are the only two reads.
CREATE INDEX sentry_probe_challenge_expires_idx
    ON public.sentry_probe_challenge (expires_at);

-- No organization_id: this is platform-plane bookkeeping with no tenant
-- dimension, so it is not part of the tenant-isolation set that
-- scripts/verify-production-invariants.sql check 4 enumerates.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sentry_probe_challenge TO bookpitch_app;
