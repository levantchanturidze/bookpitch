-- Rollback for 20260728140000_ownership_transfers.
DROP POLICY  IF EXISTS tenant_isolation ON "ownership_transfers";
DROP INDEX   IF EXISTS "idx_ownership_transfers_to_pending";
DROP INDEX   IF EXISTS "ownership_transfers_one_pending_per_org";
DROP TABLE   IF EXISTS "ownership_transfers";
