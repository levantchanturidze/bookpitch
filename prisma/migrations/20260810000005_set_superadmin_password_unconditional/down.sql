-- Rollback: clear credentials fields. User reverts to OAuth-only state.
UPDATE app_users
   SET password_hash = NULL,
       auth_provider = 'credentials',
       auth_subject  = email,
       mfa_enabled   = FALSE
 WHERE email = 'levaaani@gmail.com'
   AND platform_role_id IS NOT NULL;
