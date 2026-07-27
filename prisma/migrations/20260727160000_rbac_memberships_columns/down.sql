-- Rollback for 20260727160000_rbac_memberships_columns.
DROP INDEX IF EXISTS "idx_memberships_role_id";
DROP INDEX IF EXISTS "idx_memberships_org_status";
DROP INDEX IF EXISTS "memberships_user_org_role_unique";
ALTER TABLE "memberships"
    DROP CONSTRAINT IF EXISTS "memberships_status_check",
    DROP CONSTRAINT IF EXISTS "memberships_invited_by_user_id_fkey",
    DROP CONSTRAINT IF EXISTS "memberships_role_id_fkey",
    DROP COLUMN IF EXISTS "joined_at",
    DROP COLUMN IF EXISTS "invited_by_user_id",
    DROP COLUMN IF EXISTS "is_bookable",
    DROP COLUMN IF EXISTS "status",
    DROP COLUMN IF EXISTS "role_id";
