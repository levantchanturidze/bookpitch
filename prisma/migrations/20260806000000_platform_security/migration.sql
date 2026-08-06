-- Migration: platform_security
-- Three additive additions:
--   1. platform_rate_limit  — global (non-tenant) rate-limit buckets for
--      onboard abuse protection and platform reauth rate limiting.
--   2. platform_reauth_grant — DB-backed freshness marker so password
--      re-verification is visible across Vercel instances (replaces the
--      in-memory Map in lib/platform/password-reauth.ts).
--   3. mfa_totp column on app_users — AES-GCM encrypted TOTP secret for
--      SUPER_ADMIN break-glass 2FA. NULL = not enrolled.
--
-- Rollback: DROP TABLE platform_rate_limit; DROP TABLE platform_reauth_grant;
--           ALTER TABLE app_users DROP COLUMN mfa_totp;

-- ── 1. Global rate-limit table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_rate_limit (
  bucket       TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- Index for the housekeeping cron sweep (delete rows older than 2 hours).
CREATE INDEX IF NOT EXISTS idx_platform_rate_limit_window
  ON platform_rate_limit (window_start);

-- ── 2. Platform reauth grant table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_reauth_grant (
  user_id     UUID        NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id)
);

-- ── 3. TOTP secret column ──────────────────────────────────────────────────
-- Encrypted with FIELD_ENCRYPTION_KEY (AES-256-GCM, same scheme as
-- allergies / clinical_notes). NULL = MFA not enrolled.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS mfa_totp TEXT;

-- Track the last TOTP code used (window timestamp in seconds since epoch)
-- to prevent replay within the same 30-second window.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS mfa_last_totp_window BIGINT;
