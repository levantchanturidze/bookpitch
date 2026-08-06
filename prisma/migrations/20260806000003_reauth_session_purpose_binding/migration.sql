-- Migration: reauth_session_purpose_binding
--
-- Replaces the single-row-per-user platform_reauth_grant model with a
-- session/purpose/org-bound, single-use grant model.
--
-- Changes:
--   1. Drop and recreate platform_reauth_grant with:
--        - id UUID primary key (was user_id)
--        - auth_session_id TEXT — stable JWT session identifier
--        - purpose TEXT — allowlisted action
--        - org_id UUID — nullable target org for org-scoped actions
--        - consumed_at TIMESTAMPTZ — set atomically on consumption
--        - session_version preserved
--   2. Partial unique index: at most one unconsumed grant per (user, session, purpose)
--   3. Add pending_registrations table for email-verified onboarding
--   4. Revoke bookpitch_login from both new tables
--
-- Rollback:
--   DROP TABLE pending_registrations;
--   DROP TABLE platform_reauth_grant;
--   CREATE TABLE platform_reauth_grant (
--     user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
--     granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
--     expires_at TIMESTAMPTZ NOT NULL,
--     session_version INTEGER NOT NULL DEFAULT 0
--   );

-- ── 1. Rebuild platform_reauth_grant ─────────────────────────────────────────
DROP TABLE IF EXISTS platform_reauth_grant;

CREATE TABLE platform_reauth_grant (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  auth_session_id TEXT        NOT NULL,
  purpose         TEXT        NOT NULL,
  org_id          UUID        REFERENCES organizations(id) ON DELETE CASCADE,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  session_version INTEGER     NOT NULL DEFAULT 0,
  consumed_at     TIMESTAMPTZ
);

-- Partial unique: at most one unconsumed grant per (user, session, purpose).
-- ON CONFLICT in verifyPasswordFresh targets this index to replace stale grants.
CREATE UNIQUE INDEX idx_reauth_grant_active
  ON platform_reauth_grant (user_id, auth_session_id, purpose)
  WHERE consumed_at IS NULL;

-- For housekeeping sweep (delete consumed + expired rows after 24 hours).
CREATE INDEX idx_reauth_grant_expires
  ON platform_reauth_grant (expires_at);

-- ── 2. Pending registrations ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_registrations (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email         CITEXT      NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  full_name     TEXT        NOT NULL,
  org_name      TEXT        NOT NULL,
  location_name TEXT        NOT NULL DEFAULT 'Main location',
  location_type TEXT        NOT NULL DEFAULT 'clinic',
  -- SHA-256 hash of the random verification token. Raw token is emailed once.
  token_hash    TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_reg_token
  ON pending_registrations (token_hash);

CREATE INDEX IF NOT EXISTS idx_pending_reg_expires
  ON pending_registrations (expires_at);

-- ── 3. Revoke bookpitch_login from platform security tables ──────────────────
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookpitch_login') THEN
        REVOKE ALL ON platform_reauth_grant   FROM bookpitch_login;
        REVOKE ALL ON pending_registrations   FROM bookpitch_login;
    END IF;
END $$;
