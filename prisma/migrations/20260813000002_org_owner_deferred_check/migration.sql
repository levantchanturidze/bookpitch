-- =============================================================================
-- Phase 12 — PostgreSQL-enforced ORG_OWNER invariant.
--
-- Spec invariant 5: "Every organization keeps at least one active ORG_OWNER."
-- Application code currently enforces this (ownership-transfer.ts,
-- invitations.ts, etc.). This migration adds a DB-level backstop.
--
-- Design: DEFERRABLE INITIALLY DEFERRED constraint triggers fire at
-- COMMIT time. The function re-reads the final state of the org, so it
-- sees all writes from the transaction before judging.
--
-- Two triggers protect all mutation directions:
--
--   1. ON organizations INSERT/UPDATE — fires when an org row is created or
--      its status/owner_user_id changes. Blocks commits that leave a
--      non-archived org without owner_user_id.
--
--   2. ON memberships INSERT/UPDATE/DELETE — fires when membership state
--      changes. Blocks commits that would leave the org's owner_user_id
--      pointing at a user with no active owner membership.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS enforce_org_owner_on_org ON organizations;
--   DROP TRIGGER IF EXISTS enforce_org_owner_on_membership ON memberships;
--   DROP FUNCTION IF EXISTS check_org_owner_invariant();
--   DROP FUNCTION IF EXISTS check_org_owner_from_membership();
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Function 1: called from organizations trigger.
-- Re-reads the org's current state at commit time and rejects if a
-- non-archived org has no owner_user_id.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_org_owner_invariant()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
BEGIN
  -- For INSERT/UPDATE use NEW.id; the trigger is not fired for DELETE
  -- (organizations are never deleted in production).
  v_org_id := NEW.id;

  -- Re-read at commit time so we see all sibling writes in the transaction.
  IF EXISTS (
    SELECT 1
      FROM organizations
     WHERE id = v_org_id
       AND status <> 'archived'
       AND owner_user_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'org_owner invariant violated: organization % is non-archived but has no owner_user_id',
      v_org_id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Constraint trigger fires AFTER each org INSERT/UPDATE, deferred to
-- commit time. Covers:
--   • New org created without owner_user_id (onboarding must set it in same tx)
--   • Status changed from 'archived' to non-archived without setting owner
--   • owner_user_id explicitly nulled on a live org
CREATE CONSTRAINT TRIGGER enforce_org_owner_on_org
    AFTER INSERT OR UPDATE OF status, owner_user_id
    ON organizations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION check_org_owner_invariant();

-- -----------------------------------------------------------------------------
-- Function 2: called from memberships trigger.
-- When a membership is inserted, updated, or deleted, re-check the org's
-- invariant. Specifically catches: removing the last owner membership while
-- the org still has owner_user_id set → inconsistent state.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_org_owner_from_membership()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
BEGIN
  -- Determine which org to check. For DELETE TG_OP, OLD holds the row.
  IF TG_OP = 'DELETE' THEN
    v_org_id := OLD.organization_id;
  ELSE
    v_org_id := NEW.organization_id;
  END IF;

  -- Re-read at commit time.
  IF EXISTS (
    SELECT 1
      FROM organizations
     WHERE id = v_org_id
       AND status <> 'archived'
       AND owner_user_id IS NOT NULL
       AND NOT EXISTS (
             SELECT 1
               FROM memberships
              WHERE organization_id = v_org_id
                AND role = 'owner'
                AND status IN ('active', 'invited')
           )
  ) THEN
    RAISE EXCEPTION
      'org_owner invariant violated: organization % has owner_user_id set but no active owner membership',
      v_org_id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Constraint trigger on memberships covering insert/update/delete.
-- Catches the "removed last owner membership" case that application code
-- should already block (ownership-transfer.ts "must keep at least one owner"
-- check). The trigger is the DB-level backstop.
CREATE CONSTRAINT TRIGGER enforce_org_owner_on_membership
    AFTER INSERT OR UPDATE OF role, status, organization_id
    OR DELETE
    ON memberships
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION check_org_owner_from_membership();
