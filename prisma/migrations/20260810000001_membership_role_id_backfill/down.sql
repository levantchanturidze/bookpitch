-- No-op rollback. Setting role_id back to NULL would re-break sign-in for
-- affected users. The correct rollback is to revert the application-code fix
-- (lib/invitations.ts, lib/onboarding.ts) and run the original backfill again.
-- Tracked in docs/rbac-status.md under "membership role_id fix 2026-08-10".
SELECT 1;
