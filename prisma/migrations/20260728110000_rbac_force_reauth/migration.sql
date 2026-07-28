-- =============================================================================
-- RBAC Phase 3 — force every live JWT to invalidate on deploy.
--
-- Phase 3 adds membershipId + activeOrganizationId + platformRoleId to the
-- JWT payload. Existing JWTs don't carry those claims. Rather than write a
-- compat shim that reads the old shape, we invalidate every session.
--
-- Mechanism: bump app_users.sessionVersion by 1. The auth.ts session()
-- callback rejects any JWT whose sessionVersion is stale (5s TTL cache).
-- Every user re-signs-in on their next request.
--
-- Phase 0 Q1 accepted this cost: prod has 2 users, sub-5s re-auth is
-- imperceptible. Rollback below decrements — safe because no other flow
-- increments during the deploy window.
-- =============================================================================

UPDATE "app_users" SET "session_version" = "session_version" + 1;
