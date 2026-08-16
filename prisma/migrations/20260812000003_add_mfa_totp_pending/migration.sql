-- Phase 9: Separate pending TOTP re-enrollment secret from the active secret.
--
-- Before this change, generateTotpEnrollment() wrote the new (unconfirmed)
-- secret directly to mfa_totp, destroying the old secret immediately. A
-- SUPER_ADMIN who started re-enrollment but had not yet scanned the QR code
-- lost break-glass access. This column holds the candidate secret until
-- confirmTotpEnrollment() verifies it and promotes it to mfa_totp.
--
-- Rollback: ALTER TABLE app_users DROP COLUMN mfa_totp_pending;
ALTER TABLE app_users ADD COLUMN mfa_totp_pending text;
