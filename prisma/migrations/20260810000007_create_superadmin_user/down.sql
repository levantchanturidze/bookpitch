-- Rollback: clear credentials and platform role.
UPDATE app_users
   SET password_hash    = NULL,
       platform_role_id = NULL,
       mfa_enabled      = FALSE,
       auth_provider    = 'credentials',
       auth_subject     = email
 WHERE email = 'levaaani@gmail.com';
