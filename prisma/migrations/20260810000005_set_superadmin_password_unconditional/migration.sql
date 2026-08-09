-- Unconditionally set password_hash + auth fields for levaaani@gmail.com.
--
-- Prior migrations (000002, 000004) had NOT EXISTS guards that silently
-- skipped when the user already existed from rbac_backfill but had no
-- password_hash set (e.g. was originally OAuth-only).
--
-- This migration has no guards beyond platform_role_id IS NOT NULL so it
-- cannot create a second SUPER_ADMIN and cannot affect non-platform users.
-- Idempotent on repeated runs.

UPDATE app_users
   SET password_hash   = '$argon2id$v=19$m=19456,t=2,p=1$sWwZ73KLKQZ4ed4nXHRCbg$kgQKBGOj3L13oFwS053u+djbVc0CwUBtiNhYGuS2myM',
       auth_provider   = 'credentials',
       auth_subject    = 'levaaani@gmail.com',
       mfa_enabled     = false
 WHERE email = 'levaaani@gmail.com'
   AND platform_role_id IS NOT NULL;
