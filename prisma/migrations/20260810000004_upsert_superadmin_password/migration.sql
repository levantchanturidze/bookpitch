-- Ensure levaaani@gmail.com can sign in with credentials.
--
-- Three cases handled:
--   A. User exists already (e.g. OAuth, or prior migration created them)
--      → SET password_hash + platform_role_id.  Never creates a second SUPER_ADMIN.
--   B. User does not exist AND no SUPER_ADMIN exists anywhere
--      → INSERT as SUPER_ADMIN. First-run bootstrap.
--   C. User does not exist AND a SUPER_ADMIN already exists elsewhere (dev seed)
--      → no-op. The existing SUPER_ADMIN is the platform account.
--
-- Password (Bookpitch2026!) must be changed after first sign-in.
-- Idempotent on repeated runs.

-- Case A: user already exists → patch in credentials + platform role.
UPDATE app_users
   SET password_hash   = '$argon2id$v=19$m=19456,t=2,p=1$sWwZ73KLKQZ4ed4nXHRCbg$kgQKBGOj3L13oFwS053u+djbVc0CwUBtiNhYGuS2myM',
       platform_role_id = (SELECT id FROM roles WHERE key = 'SUPER_ADMIN' AND organization_id IS NULL),
       auth_provider   = 'credentials',
       auth_subject    = 'levaaani@gmail.com',
       mfa_enabled     = false
 WHERE email = 'levaaani@gmail.com';

-- Case B: user does not exist AND no SUPER_ADMIN anywhere → INSERT.
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
  AND NOT EXISTS (SELECT 1 FROM app_users WHERE email = 'levaaani@gmail.com')
  AND NOT EXISTS (
    SELECT 1 FROM app_users WHERE platform_role_id = r.id
  );
