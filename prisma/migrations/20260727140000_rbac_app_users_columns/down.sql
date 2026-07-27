-- Rollback for 20260727140000_rbac_app_users_columns.
DROP INDEX IF EXISTS "idx_app_users_platform_role";
DROP INDEX IF EXISTS "idx_app_users_status";
ALTER TABLE "app_users"
    DROP CONSTRAINT IF EXISTS "app_users_platform_role_id_fkey",
    DROP CONSTRAINT IF EXISTS "app_users_status_check",
    DROP COLUMN IF EXISTS "platform_role_id",
    DROP COLUMN IF EXISTS "last_login_at",
    DROP COLUMN IF EXISTS "mfa_enabled",
    DROP COLUMN IF EXISTS "locale",
    DROP COLUMN IF EXISTS "status";
