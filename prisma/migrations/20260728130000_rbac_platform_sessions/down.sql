-- Rollback for 20260728130000_rbac_platform_sessions.
DROP INDEX IF EXISTS "idx_break_glass_sessions_actor_active";
DROP INDEX IF EXISTS "idx_impersonation_sessions_org";
DROP INDEX IF EXISTS "idx_impersonation_sessions_actor_active";
DROP TABLE IF EXISTS "break_glass_sessions";
DROP TABLE IF EXISTS "impersonation_sessions";
