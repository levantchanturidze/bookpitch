-- =============================================================================
-- Phase 12 v5 — Enforce Case B (owner_user_id→NULL) on org UPDATE only.
--
-- The INSERT trigger fires with the INSERT-time row values and cannot see
-- members added later in the same tx. So for INSERT, we only enforce Case A
-- (owner_user_id IS NOT NULL → membership must exist).
--
-- For UPDATE, the trigger fires with the new values after the UPDATE, and
-- Case B must also be enforced: if owner_user_id is being set to NULL while
-- the org still has members, the invariant is violated.
--
-- TG_OP distinguishes INSERT from UPDATE.
-- Rollback: re-apply 20260813000007/migration.sql.
-- =============================================================================

CREATE OR REPLACE FUNCTION check_org_owner_invariant()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('archived', 'pending_setup') THEN
    RETURN NULL;
  END IF;

  IF NEW.owner_user_id IS NOT NULL THEN
    -- Case A (INSERT and UPDATE): if owner is set, active owner membership required.
    IF NOT EXISTS (
      SELECT 1 FROM memberships
       WHERE organization_id = NEW.id
         AND role = 'owner' AND status = 'active'
    ) THEN
      RAISE EXCEPTION
        'org_owner invariant violated: org % has owner_user_id set but no active owner membership',
        NEW.id USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Case B (UPDATE only): if owner_user_id is cleared, no members may remain.
    IF EXISTS (SELECT 1 FROM memberships WHERE organization_id = NEW.id) THEN
      RAISE EXCEPTION
        'org_owner invariant violated: org % has members but owner_user_id was cleared',
        NEW.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  -- Case B for INSERT: skip — handled by the membership trigger.

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_org_owner_on_org ON organizations;
CREATE CONSTRAINT TRIGGER enforce_org_owner_on_org
  AFTER INSERT OR UPDATE OF owner_user_id, status
  ON organizations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_org_owner_invariant();
