-- Rollback for 20260728110000_rbac_force_reauth.
--
-- Symmetric decrement. Only meaningful if no other flow bumped
-- session_version between forward and rollback — but in that window the app
-- is either mid-deploy or already rolled back, so no user activity is
-- expected. In the worst case, the rollback leaves session_version one
-- higher than pre-Phase-3, which just means one extra forced re-auth for
-- that user. Harmless.

UPDATE "app_users" SET "session_version" = GREATEST(1, "session_version" - 1);
