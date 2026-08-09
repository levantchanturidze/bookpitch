-- Rollback: remove the SUPER_ADMIN platform_role_id and password.
-- If the account was originally OAuth-only, this restores it to that state.
UPDATE app_users
   SET password_hash   = NULL,
       platform_role_id = NULL,
       mfa_enabled      = FALSE,
       auth_provider    = 'credentials',
       auth_subject     = email
 WHERE email = 'levaaani@gmail.com';
