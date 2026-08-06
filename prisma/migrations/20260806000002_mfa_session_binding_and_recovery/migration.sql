-- Migration: mfa_session_binding_and_recovery
--
-- 1. Bind platform_reauth_grant to the user's session_version so that
--    password changes, role revocations, and break-glass events (all of
--    which bump session_version on app_users) automatically invalidate
--    any outstanding reauth grant.
--
-- 2. Create app_user_recovery_codes — single-use backup codes for TOTP
--    recovery when the authenticator app is unavailable.
--
-- Rollback:
--   ALTER TABLE platform_reauth_grant DROP COLUMN IF EXISTS session_version;
--   DROP TABLE IF EXISTS app_user_recovery_codes;

-- ── 1. Session-version binding on reauth grants ────────────────────────────
-- DEFAULT 0 safely backfills existing rows; next successful verifyPasswordFresh
-- will overwrite them with the real session_version.
ALTER TABLE platform_reauth_grant
  ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

-- ── 2. MFA recovery codes ─────────────────────────────────────────────────
-- Each row is one single-use recovery code (stored as SHA-256 hash).
-- The index covers only unused codes so the consumption query is fast.
CREATE TABLE IF NOT EXISTS app_user_recovery_codes (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  code_hash   TEXT        NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_unused
  ON app_user_recovery_codes (user_id)
  WHERE used_at IS NULL;

-- bookpitch_login (narrow auth-graph role) must not read recovery code hashes.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookpitch_login') THEN
        REVOKE ALL ON app_user_recovery_codes FROM bookpitch_login;
    END IF;
END $$;
