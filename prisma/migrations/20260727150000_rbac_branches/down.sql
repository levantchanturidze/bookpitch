-- Rollback for 20260727150000_rbac_branches.
DROP TABLE IF EXISTS "membership_branches";
DROP TRIGGER IF EXISTS trg_branches_updated ON "branches";
DROP TABLE IF EXISTS "branches";
