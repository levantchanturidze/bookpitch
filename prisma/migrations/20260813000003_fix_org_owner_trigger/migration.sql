-- =============================================================================
-- Correct the Phase 12 deferred constraint trigger functions.
--
-- The initial version (20260813000002) fired for ANY non-archived org with
-- owner_user_id IS NULL, including bare orgs created as test fixtures or
-- just-created orgs not yet populated with a membership. This was too
-- aggressive: the real invariant (CLAUDE.md §5) is:
--
--   "Every organization KEEPS at least one active ORG_OWNER."
--
-- "Keeps" implies the org already has (or had) members. A freshly-created
-- org with zero memberships has never had an owner and is not violating the
-- invariant — it just hasn't been configured yet.
--
-- Corrected semantics:
--   • check_org_owner_invariant: only fires if the org has ≥1 membership.
--     An org with no memberships is in "setup" state and exempt.
--   • check_org_owner_from_membership: only fires if the org is non-archived
--     AND has owner_user_id set AND now has zero active owner memberships.
--
-- These guards continue to block:
--   • Committing a transaction that added a first membership to an org
--     without setting owner_user_id in the same transaction.
--   • Removing the last owner membership from an org that has owner_user_id.
--   • Changing an org from archived → active when it has members but no owner.
--
-- Rollback: re-apply the previous versions from 20260813000002/migration.sql.
-- =============================================================================

CREATE OR REPLACE FUNCTION check_org_owner_invariant()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
BEGIN
  v_org_id := NEW.id;

  -- Only enforce when the org actually has at least one membership.
  -- An org in "setup" state (zero memberships) is exempt from the invariant
  -- because it has never had an owner to keep.
  IF EXISTS (
    SELECT 1
      FROM organizations o
     WHERE o.id = v_org_id
       AND o.status <> 'archived'
       AND o.owner_user_id IS NULL
       AND EXISTS (
             SELECT 1 FROM memberships m WHERE m.organization_id = v_org_id
           )
  ) THEN
    RAISE EXCEPTION
      'org_owner invariant violated: organization % has members but no owner_user_id',
      v_org_id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION check_org_owner_from_membership()
RETURNS trigger AS $$
DECLARE
  v_org_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_org_id := OLD.organization_id;
  ELSE
    v_org_id := NEW.organization_id;
  END IF;

  -- Enforce: if the org is non-archived, has owner_user_id set, and now has
  -- zero active owner memberships, the transaction is inconsistent.
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
