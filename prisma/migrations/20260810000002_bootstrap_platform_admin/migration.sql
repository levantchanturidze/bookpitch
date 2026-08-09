-- Bootstrap the first SUPER_ADMIN platform user if none exists.
--
-- Runs idempotently: the INSERT is guarded by NOT EXISTS on platform_role_id.
-- Password (Bookpitch2026!) must be changed after first sign-in.
-- Email: levaaani@gmail.com (platform owner).

INSERT INTO app_users (
  id,
  auth_provider,
  auth_subject,
  email,
  full_name,
  password_hash,
  platform_role_id,
  mfa_enabled,
  created_at
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
WHERE r.key = 'SUPER_ADMIN'
  AND r.organization_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM app_users u2
    WHERE u2.platform_role_id = r.id
  );
