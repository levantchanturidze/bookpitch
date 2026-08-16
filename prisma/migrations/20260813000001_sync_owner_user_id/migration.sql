-- =============================================================================
-- Sync trigger extension: keep organizations.owner_user_id in sync when an
-- owner membership is created or the role changes.
--
-- Before this migration, rbac_memberships_sync() filled role_id / joined_at /
-- is_bookable but did NOT touch organizations.owner_user_id. Application code
-- sets owner_user_id explicitly (onboarding, invitations, orgs). When test
-- code or other callers create an org + owner membership without the explicit
-- update, owner_user_id stays NULL — violating invariant B.
--
-- This migration closes that gap:
--   • On INSERT of an owner membership, if the org has no owner_user_id, set it.
--   • On UPDATE that changes role TO 'owner', same.
--   • Backfill: fix any non-archived orgs that already have owner memberships
--     but owner_user_id is NULL.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS memberships_rbac_sync ON memberships;
--   CREATE OR REPLACE FUNCTION rbac_memberships_sync() ...  (restore Phase 2 version)
-- =============================================================================

-- Replace the existing trigger function with the extended version.
-- CREATE OR REPLACE is safe for BEFORE triggers — Postgres replaces in-place.
CREATE OR REPLACE FUNCTION rbac_memberships_sync() RETURNS trigger AS $$
BEGIN
    IF NEW.role_id IS NULL AND NEW.role IS NOT NULL THEN
        NEW.role_id := rbac_role_id_for_user_role(NEW.role);
    END IF;
    IF NEW.joined_at IS NULL THEN
        NEW.joined_at := COALESCE(NEW.created_at, CURRENT_TIMESTAMP);
    END IF;
    IF TG_OP = 'INSERT' AND NEW.role IN ('owner','practitioner') THEN
        NEW.is_bookable := TRUE;
    END IF;

    -- If an owner membership is inserted (or updated to role='owner') and the
    -- org does not yet have an owner_user_id, fill it now. This prevents the
    -- invariant B violation when callers create the org before the user exists
    -- and forget the explicit organization.update call.
    IF NEW.role = 'owner' AND NEW.status IN ('active', 'invited') THEN
        UPDATE organizations
           SET owner_user_id = NEW.user_id
         WHERE id = NEW.organization_id
           AND owner_user_id IS NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger definition unchanged — the BEFORE trigger on memberships still
-- fires on INSERT OR UPDATE OF role, role_id, joined_at, is_bookable.
-- Drop + recreate to pick up any signature change (idempotent pattern).
DROP TRIGGER IF EXISTS memberships_rbac_sync ON memberships;
CREATE TRIGGER memberships_rbac_sync
    BEFORE INSERT OR UPDATE OF role, role_id, joined_at, is_bookable
    ON "memberships"
    FOR EACH ROW EXECUTE FUNCTION rbac_memberships_sync();

-- =============================================================================
-- Backfill: fix any pre-existing violations (non-archived orgs with an active
-- owner membership but owner_user_id still NULL).
-- =============================================================================
UPDATE organizations o
   SET owner_user_id = (
         SELECT m.user_id
           FROM memberships m
          WHERE m.organization_id = o.id
            AND m.role = 'owner'
            AND m.status IN ('active', 'invited')
          ORDER BY m.created_at
          LIMIT 1
       )
 WHERE o.status <> 'archived'
   AND o.owner_user_id IS NULL
   AND EXISTS (
         SELECT 1 FROM memberships m
          WHERE m.organization_id = o.id
            AND m.role = 'owner'
            AND m.status IN ('active', 'invited')
       );
