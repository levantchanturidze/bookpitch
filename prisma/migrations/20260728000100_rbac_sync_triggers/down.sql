-- Rollback for 20260728000100_rbac_sync_triggers.
-- Drop triggers first, then their functions, then the helper.
--
-- Apply this BEFORE the backfill down.sql (see runbook). Reason: leaving
-- the sync triggers in place while the backfill rolls back would cause
-- weird half-states — e.g. deleting branches rows would leave the app
-- inserting them right back when the next locations row lands.

DROP TRIGGER IF EXISTS locations_rbac_sync_delete ON "locations";
DROP TRIGGER IF EXISTS locations_rbac_sync_update ON "locations";
DROP TRIGGER IF EXISTS locations_rbac_sync_insert ON "locations";
DROP TRIGGER IF EXISTS memberships_rbac_sync     ON "memberships";

DROP FUNCTION IF EXISTS rbac_locations_sync_delete();
DROP FUNCTION IF EXISTS rbac_locations_sync_update();
DROP FUNCTION IF EXISTS rbac_locations_sync_insert();
DROP FUNCTION IF EXISTS rbac_memberships_sync();
DROP FUNCTION IF EXISTS rbac_role_id_for_user_role(user_role);
