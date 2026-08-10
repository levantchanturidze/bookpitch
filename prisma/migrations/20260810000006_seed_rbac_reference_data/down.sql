-- Rollback: remove levaaani@gmail.com credentials (restores to pre-migration state).
-- Roles/permissions/role_permissions are NOT rolled back — removing them would
-- break any memberships or platform sessions that were created after this migrated.
UPDATE app_users
   SET password_hash    = NULL,
       platform_role_id = NULL,
       mfa_enabled      = FALSE,
       auth_provider    = 'credentials',
       auth_subject     = email
 WHERE email = 'levaaani@gmail.com';
