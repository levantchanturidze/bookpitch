-- Phase 13: Track when a pending TOTP re-enrollment secret was written so
-- housekeeping can sweep stale ones (user started re-enrollment, never confirmed).
-- Without the timestamp, housekeeping cannot distinguish an active re-enrollment
-- from an abandoned one that has been sitting there for weeks.
--
-- Rollback: ALTER TABLE app_users DROP COLUMN mfa_totp_pending_created_at;
ALTER TABLE app_users ADD COLUMN mfa_totp_pending_created_at timestamptz;
