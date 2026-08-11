-- Ensure levaaani@gmail.com exists as SUPER_ADMIN with credentials.
--
-- All prior bootstrap attempts (000002, 000004, 000005, 000006) had guards
-- that silently skipped because:
--   • roles table was empty in production (no `db:seed` in prod), so the
--     SUPER_ADMIN role FK didn't exist → subqueries returned NULL → all
--     "no other SUPER_ADMIN" guards evaluated as NOT EXISTS(∅) = FALSE
--     because the FROM clause itself returned zero rows.
--   • Migration 000006 seeded roles but the INSERT still had the "no other
--     SUPER_ADMIN" guard — which was FALSE in environments where seed
--     already ran (dev/CI) or where a prior migration had set platform_role_id
--     on another user.
--
-- This migration removes all guards. It is safe because:
--   • Only touches the single email address.
--   • Does not grant anything to unrelated users.
--   • ON CONFLICT (email) DO UPDATE is idempotent — re-running is safe.
--   • In dev/CI where superadmin@bp.test already exists, this creates a
--     second SUPER_ADMIN; P6.15 is updated to account for that.

INSERT INTO app_users (
  id, auth_provider, auth_subject, email, full_name,
  password_hash, platform_role_id, mfa_enabled, created_at
)
SELECT
  gen_random_uuid(),
  'credentials',
  'levaaani@gmail.com',
  'levaaani@gmail.com',
  'Levan Tchanturidze',
  '$argon2id$v=19$m=19456,t=2,p=1$sWwZ73KLKQZ4ed4nXHRCbg$kgQKBGOj3L13oFwS053u+djbVc0CwUBtiNhYGuS2myM',
  r.id,
  false,
  now()
FROM roles r
WHERE r.key = 'SUPER_ADMIN' AND r.organization_id IS NULL
ON CONFLICT (email) DO UPDATE
  SET password_hash    = EXCLUDED.password_hash,
      platform_role_id = EXCLUDED.platform_role_id,
      auth_provider    = EXCLUDED.auth_provider,
      auth_subject     = EXCLUDED.auth_subject,
      mfa_enabled      = EXCLUDED.mfa_enabled;
