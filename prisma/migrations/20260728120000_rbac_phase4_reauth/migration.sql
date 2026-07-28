-- =============================================================================
-- RBAC Phase 4 — remove the legacy JWT aliases (`organizationId`, `role`).
--
-- Phase 3 mint added `activeOrganizationId`, `membershipId`, `platformRoleId`
-- to every JWT but kept `organizationId` + `role` as compat aliases for the
-- ~85 requireRole() callsites. Phase 4 swapped every callsite to
-- requirePermission(); the aliases are now dead weight. Removing them from
-- auth.ts requires evicting every live JWT that still carries them.
--
-- Same mechanism as the Phase 3 reauth: bump sessionVersion for every user.
-- The auth.ts session() callback rejects stale JWTs within SV_TTL_MS (5s).
-- Users re-sign-in on their next request. Prod is 2 users; cost is trivial.
--
-- Rollback below decrements — safe because no other flow bumps
-- sessionVersion during deploy.
-- =============================================================================

UPDATE "app_users" SET "session_version" = "session_version" + 1;
