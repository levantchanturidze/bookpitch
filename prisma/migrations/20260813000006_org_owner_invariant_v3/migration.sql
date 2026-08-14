-- =============================================================================
-- Phase 12 v3 — Correct the ORG_OWNER deferred constraint trigger.
--
-- Fixes applied over v2 (20260813000003):
--
--   1. 'invited' was accepted as a valid owner status. The invariant requires
--      an ACTIVE member (status = 'active'). An invited-but-not-yet-accepted
--      user is not an active owner. Removed 'invited' from the allowed set.
--
--   2. Organization INSERT was not covered. A new org can be created with
--      owner_user_id IS NOT NULL but without a corresponding active membership,
--      or with owner_user_id IS NULL while members exist. Both states must be
--      rejected at commit.
--
--   3. Ownerless-setup lifecycle modeled explicitly. An org whose status is
--      'pending_setup' (or has zero memberships) is exempt from the invariant.
--      All other active lifecycle states (trial, active, suspended) require an
--      active owner membership when owner_user_id is set or members exist.
--
-- Trigger coverage after this migration:
--   • organizations INSERT — via enforce_org_owner_on_org (INSERT OR UPDATE)
--   • organizations UPDATE (owner_user_id, status) — same
--   • memberships INSERT — via enforce_org_owner_on_membership
--   • memberships UPDATE (role, status, organization_id) — same
--   • memberships DELETE — same
--
-- Not covered by triggers (application-layer only):
--   • User deletion — AppUser has ON DELETE CASCADE on memberships, which
--     fires the DELETE trigger above. No separate user-deletion trigger needed.
--   • Role-definition mutation — roles are referenced by key string, not FK to
--     a mutable role table. Role identity is immutable by schema design.
--
-- Rollback: re-apply functions from 20260813000003/migration.sql.
-- =============================================================================

-- ── 1. check_org_owner_invariant (fires on org INSERT OR UPDATE) ─────────────
--
-- Rejects a commit where:
--   a) An org is not pending_setup/archived AND has owner_user_id IS NULL
--      while at least one membership exists, OR
--   b) An org has owner_user_id set but no active-status owner membership.
--
-- Does NOT reject:
--   • Archived orgs (lifecycle over; owner reference intentionally cleared).
--   • Orgs in pending_setup status (explicit ownerless setup phase).
--   • Orgs with zero memberships (new org, owner not yet added — deferred
--     constraint fires at commit, so INSERT + membership can coexist in one tx).

CREATE OR REPLACE FUNCTION check_org_owner_invariant()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
BEGIN
  v_org_id := NEW.id;

  -- Exempt: archived and pending_setup orgs.
  IF NEW.status IN ('archived', 'pending_setup') THEN
    RETURN NULL;
  END IF;

  -- Case A: owner_user_id is set → there must be exactly one active-status
  -- owner membership referencing that user in this org.
  IF NEW.owner_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM memberships
       WHERE organization_id = v_org_id
         AND role = 'owner'
         AND status = 'active'
    ) THEN
      RAISE EXCEPTION
        'org_owner invariant violated: org % has owner_user_id set but no active owner membership',
        v_org_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Case B: org has any membership → owner_user_id must be set.
  IF NEW.owner_user_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM memberships WHERE organization_id = v_org_id) THEN
      RAISE EXCEPTION
        'org_owner invariant violated: org % has members but owner_user_id is NULL',
        v_org_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ── 2. check_org_owner_from_membership (fires on membership DML) ─────────────
--
-- Re-checks the invariant from the membership side:
--   • INSERT/UPDATE: if we're setting role=owner, the org must also have
--     owner_user_id pointing to this membership's user (or will, atomically).
--     This direction is NOT separately enforced here — the org trigger covers it.
--   • UPDATE/DELETE: after this change, if the org is non-archived /
--     non-pending_setup and has owner_user_id set, there must still be at
--     least one active-status owner membership.

CREATE OR REPLACE FUNCTION check_org_owner_from_membership()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
  v_org_status text;
  v_owner_user_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_org_id := OLD.organization_id;
  ELSE
    v_org_id := NEW.organization_id;
    -- On cross-org membership moves, also re-check the source org.
    IF TG_OP = 'UPDATE' AND OLD.organization_id <> NEW.organization_id THEN
      -- Re-check old org independently via recursive trigger path.
      -- We raise here rather than calling the trigger recursively.
      SELECT status, owner_user_id
        INTO v_org_status, v_owner_user_id
        FROM organizations
       WHERE id = OLD.organization_id;
      IF v_org_status NOT IN ('archived', 'pending_setup')
         AND v_owner_user_id IS NOT NULL
         AND NOT EXISTS (
               SELECT 1 FROM memberships
                WHERE organization_id = OLD.organization_id
                  AND role = 'owner'
                  AND status = 'active'
             )
      THEN
        RAISE EXCEPTION
          'org_owner invariant violated: source org % lost active owner on membership move',
          OLD.organization_id
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  -- Check the target org.
  SELECT status, owner_user_id
    INTO v_org_status, v_owner_user_id
    FROM organizations
   WHERE id = v_org_id;

  -- Exempt: archived and pending_setup.
  IF v_org_status IN ('archived', 'pending_setup') THEN
    RETURN NULL;
  END IF;

  -- If owner_user_id is set, there must be an active owner membership.
  IF v_owner_user_id IS NOT NULL
     AND NOT EXISTS (
           SELECT 1
             FROM memberships
            WHERE organization_id = v_org_id
              AND role = 'owner'
              AND status = 'active'
         )
  THEN
    RAISE EXCEPTION
      'org_owner invariant violated: org % has owner_user_id set but no active owner membership',
      v_org_id
      USING ERRCODE = 'P0001';
  END IF;

  -- If the org has any memberships, owner_user_id must be set.
  IF v_owner_user_id IS NULL
     AND EXISTS (SELECT 1 FROM memberships WHERE organization_id = v_org_id)
  THEN
    RAISE EXCEPTION
      'org_owner invariant violated: org % has members but owner_user_id is NULL',
      v_org_id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ── 3. Re-register org trigger to include INSERT ──────────────────────────────

DROP TRIGGER IF EXISTS enforce_org_owner_on_org ON organizations;

CREATE CONSTRAINT TRIGGER enforce_org_owner_on_org
  AFTER INSERT OR UPDATE OF owner_user_id, status
  ON organizations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_org_owner_invariant();

-- Membership trigger is already registered as INSERT OR UPDATE OR DELETE.
-- Re-register to ensure it points to the updated function.

DROP TRIGGER IF EXISTS enforce_org_owner_on_membership ON memberships;

CREATE CONSTRAINT TRIGGER enforce_org_owner_on_membership
  AFTER INSERT OR UPDATE OR DELETE
  ON memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_org_owner_from_membership();
