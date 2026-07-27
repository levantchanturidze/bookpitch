-- Rollback for 20260727120000_rbac_organizations_columns.
-- Run manually via psql; Prisma does not execute down.sql automatically.
DROP INDEX IF EXISTS "idx_org_owner_user_id";
DROP INDEX IF EXISTS "idx_org_status";
ALTER TABLE "organizations"
    DROP CONSTRAINT IF EXISTS "organizations_vertical_check",
    DROP CONSTRAINT IF EXISTS "organizations_status_check",
    DROP CONSTRAINT IF EXISTS "organizations_owner_user_id_fkey",
    DROP COLUMN IF EXISTS "allow_support_impersonation",
    DROP COLUMN IF EXISTS "owner_user_id",
    DROP COLUMN IF EXISTS "status",
    DROP COLUMN IF EXISTS "brand_name",
    DROP COLUMN IF EXISTS "legal_name",
    DROP COLUMN IF EXISTS "vertical";
