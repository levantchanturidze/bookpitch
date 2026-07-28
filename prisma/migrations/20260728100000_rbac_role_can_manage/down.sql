-- Rollback for 20260728100000_rbac_role_can_manage.
DROP INDEX IF EXISTS "idx_role_can_manage_parent";
DROP TABLE IF EXISTS "role_can_manage";
