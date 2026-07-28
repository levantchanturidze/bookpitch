-- Rollback for 20260728120000_rbac_phase4_reauth.
-- See 20260728110000_rbac_force_reauth/down.sql for the same pattern.

UPDATE "app_users" SET "session_version" = GREATEST(1, "session_version" - 1);
