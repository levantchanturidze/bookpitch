-- =============================================================================
-- Phase 12 v4 — Fix deferred-trigger row-value semantics.
--
-- PostgreSQL DEFERRABLE INITIALLY DEFERRED row-level triggers fire at commit
-- using the column values captured at triggering-statement execution time,
-- NOT the current committed row values. This means:
--
--   • The org INSERT trigger sees NEW.owner_user_id = NULL even if a later
--     UPDATE in the same tx set owner_user_id to a real value.
--   • We cannot check "are there now memberships?" inside the org INSERT
--     trigger for the case where owner_user_id was NULL at INSERT time,
--     because that case is always correct at INSERT time and would only
--     become wrong if members were added without setting owner_user_id —
--     which is already caught by the MEMBERSHIP trigger.
--
-- Revised semantics:
--
--   check_org_owner_invariant (org INSERT OR UPDATE):
--     Case A (owner_user_id IS NOT NULL at statement time):
--       At commit, active owner membership must exist.
--     Case B (owner_user_id IS NULL at statement time):
--       Skip entirely — the membership trigger covers "org has members but
--       no owner_user_id" on every membership DML.
--
--   check_org_owner_from_membership (membership INSERT/UPDATE/DELETE):
--     Reads current org state via SELECT (sees all tx changes at commit).
--     Enforces:
--       (i)  If org has owner_user_id set → active owner membership must exist.
--       (ii) If org has any membership → owner_user_id must be set.
--     Both read live org state, so they correctly see the final tx state.
--
-- Rollback: re-apply 20260813000006/migration.sql.
-- =============================================================================

CREATE OR REPLACE FUNCTION check_org_owner_invariant()
RETURNS trigger AS $$
BEGIN
  -- Exempt: archived and pending_setup orgs.
  IF NEW.status IN ('archived', 'pending_setup') THEN
    RETURN NULL;
  END IF;

  -- Only enforce when owner_user_id was explicitly set at statement time.
  -- When it was NULL at INSERT/UPDATE, the membership trigger covers the
  -- complementary invariant (members ↔ owner_user_id).
  IF NEW.owner_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM memberships
       WHERE organization_id = NEW.id
         AND role = 'owner'
         AND status = 'active'
    ) THEN
      RAISE EXCEPTION
        'org_owner invariant violated: org % has owner_user_id set but no active owner membership',
        NEW.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

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

  -- Cross-org membership move: also validate the source org.
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
                  AND role = 'owner' AND status = 'active'
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

  -- Read current org state (SELECT sees live tx state at deferred-fire time).
  SELECT status, owner_user_id
    INTO v_org_status, v_owner_uid
    FROM organizations
   WHERE id = v_org_id;

  IF v_org_status IN ('archived', 'pending_setup') THEN
    RETURN NULL;
  END IF;

  -- (i) owner_user_id set → active owner membership must exist.
  IF v_owner_uid IS NOT NULL
     AND NOT EXISTS (
           SELECT 1 FROM memberships
            WHERE organization_id = v_org_id
              AND role = 'owner' AND status = 'active'
         )
  THEN
    RAISE EXCEPTION
      'org_owner invariant violated: org % has owner_user_id set but no active owner membership',
      v_org_id USING ERRCODE = 'P0001';
  END IF;

  -- (ii) any membership exists → owner_user_id must be set.
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

-- Re-register triggers (idempotent via DROP IF EXISTS).
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
