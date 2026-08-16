-- =============================================================================
-- Phase 12 v6 — owner_user_id same-user enforcement.
--
-- Gap closed: the previous trigger only checked that SOME active owner
-- membership existed. It did not verify that the active owner membership
-- belongs to the user referenced by owner_user_id.
--
-- Consequence of the gap: org with owner_user_id=A while user B (not A) held
-- the only active owner membership would pass the trigger.
--
-- Fix: add `AND user_id = NEW.owner_user_id` to the org trigger, and
--      `AND user_id = v_owner_uid`            to the membership trigger.
--
-- Both deferred constraints fire at commit, so they see the final settled
-- state of the transaction, not intermediate values.
--
-- Rollback: re-apply 20260813000009/migration.sql (v5).
-- =============================================================================

-- ── 1. Org-side trigger: owner_user_id IS NOT NULL → that specific user must
--       have an active owner membership. ─────────────────────────────────────

CREATE OR REPLACE FUNCTION check_org_owner_invariant()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('archived', 'pending_setup') THEN
    RETURN NULL;
  END IF;

  IF NEW.owner_user_id IS NOT NULL THEN
    -- The active owner membership must belong to owner_user_id specifically,
    -- not just any user with role='owner'.
    IF NOT EXISTS (
      SELECT 1 FROM memberships
       WHERE organization_id = NEW.id
         AND user_id          = NEW.owner_user_id
         AND role             = 'owner'
         AND status           = 'active'
    ) THEN
      RAISE EXCEPTION
        'org_owner invariant violated: org % has owner_user_id set but no matching active owner membership',
        NEW.id USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF EXISTS (SELECT 1 FROM memberships WHERE organization_id = NEW.id) THEN
      RAISE EXCEPTION
        'org_owner invariant violated: org % has members but owner_user_id was cleared',
        NEW.id USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ── 2. Membership-side trigger: when the org has owner_user_id set, that
--       specific user must still hold an active owner membership after DML. ──

CREATE OR REPLACE FUNCTION check_org_owner_from_membership()
RETURNS trigger AS $$
DECLARE
  v_org_id      uuid;
  v_org_status  text;
  v_owner_uid   uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_org_id := OLD.organization_id;
  ELSE
    v_org_id := NEW.organization_id;
  END IF;

  -- Cross-org membership move: re-check source org.
  IF TG_OP = 'UPDATE' AND OLD.organization_id <> NEW.organization_id THEN
    SELECT status, owner_user_id
      INTO v_org_status, v_owner_uid
      FROM organizations
     WHERE id = OLD.organization_id;

    IF v_org_status NOT IN ('archived', 'pending_setup') THEN
      IF v_owner_uid IS NOT NULL
         AND NOT EXISTS (
               SELECT 1 FROM memberships
                WHERE organization_id = OLD.organization_id
                  AND user_id          = v_owner_uid
                  AND role             = 'owner'
                  AND status           = 'active'
             )
      THEN
        RAISE EXCEPTION
          'org_owner invariant violated: source org % lost active owner on membership move',
          OLD.organization_id USING ERRCODE = 'P0001';
      END IF;
      IF v_owner_uid IS NULL
         AND EXISTS (SELECT 1 FROM memberships WHERE organization_id = OLD.organization_id)
      THEN
        RAISE EXCEPTION
          'org_owner invariant violated: source org % has members but owner_user_id is NULL',
          OLD.organization_id USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  SELECT status, owner_user_id
    INTO v_org_status, v_owner_uid
    FROM organizations
   WHERE id = v_org_id;

  IF v_org_status IN ('archived', 'pending_setup') THEN
    RETURN NULL;
  END IF;

  -- The specific owner_user_id must hold an active owner membership.
  IF v_owner_uid IS NOT NULL
     AND NOT EXISTS (
           SELECT 1 FROM memberships
            WHERE organization_id = v_org_id
              AND user_id          = v_owner_uid
              AND role             = 'owner'
              AND status           = 'active'
         )
  THEN
    RAISE EXCEPTION
      'org_owner invariant violated: org % has owner_user_id set but no matching active owner membership',
      v_org_id USING ERRCODE = 'P0001';
  END IF;

  IF v_owner_uid IS NULL
     AND EXISTS (SELECT 1 FROM memberships WHERE organization_id = v_org_id)
  THEN
    RAISE EXCEPTION
      'org_owner invariant violated: org % has members but owner_user_id is NULL',
      v_org_id USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ── 3. Re-register triggers (idempotent). ────────────────────────────────────

DROP TRIGGER IF EXISTS enforce_org_owner_on_org ON organizations;
CREATE CONSTRAINT TRIGGER enforce_org_owner_on_org
  AFTER INSERT OR UPDATE OF owner_user_id, status
  ON organizations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_org_owner_invariant();

DROP TRIGGER IF EXISTS enforce_org_owner_on_membership ON memberships;
CREATE CONSTRAINT TRIGGER enforce_org_owner_on_membership
  AFTER INSERT OR UPDATE OR DELETE
  ON memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_org_owner_from_membership();
