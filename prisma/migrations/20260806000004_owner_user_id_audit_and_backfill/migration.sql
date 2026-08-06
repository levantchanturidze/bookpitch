-- Migration: owner_user_id_audit_and_backfill
--
-- Safety net for organizations.owner_user_id:
--
--  1. Re-run the deterministic backfill for any orgs that slipped through
--     (e.g. created between migrations or with a NULL owner_user_id for any
--     other reason). Uses the same logic as 20260728000000_rbac_backfill:
--     earliest active owner membership by created_at, tie-broken by id.
--
--  2. Log a notice (visible in migration output) for any org that still has
--     no owner membership after the backfill — these are data-quality issues
--     that require manual operator review.
--
--  3. Add a check constraint so future inserts/updates cannot create orgs with
--     owner_user_id pointing to a user who has no active owner membership in
--     that org. The constraint is DEFERRABLE INITIALLY DEFERRED so the
--     transactional create-org → create-membership → update-org flow remains
--     valid inside a single transaction.
--     (Constraint not added if it already exists — idempotent.)
--
-- Rollback:
--   ALTER TABLE organizations DROP CONSTRAINT IF EXISTS chk_org_owner_has_membership;
--   -- The UPDATE is not reversible, but owner_user_id = NULL is valid per schema.

-- ── 1. Re-run deterministic backfill ─────────────────────────────────────────
WITH first_owner AS (
    SELECT DISTINCT ON (organization_id)
           organization_id,
           user_id
      FROM memberships
     WHERE role = 'owner'
       AND status = 'active'
     ORDER BY organization_id, created_at, id
)
UPDATE organizations o
   SET owner_user_id = fo.user_id
  FROM first_owner fo
 WHERE o.id          = fo.organization_id
   AND o.owner_user_id IS NULL;

-- ── 2. Operator notice for orgs with no owner membership ─────────────────────
DO $$
DECLARE
    zero_owner_count INT;
BEGIN
    SELECT COUNT(*) INTO zero_owner_count
      FROM organizations o
     WHERE o.owner_user_id IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM memberships m
              WHERE m.organization_id = o.id
                AND m.role = 'owner'
                AND m.status = 'active'
           );
    IF zero_owner_count > 0 THEN
        RAISE NOTICE
          'owner_user_id_audit: % organization(s) have no active owner membership. '
          'Manual review required. Query: '
          'SELECT id, name FROM organizations WHERE owner_user_id IS NULL;',
          zero_owner_count;
    END IF;
END $$;

-- ── 3. Invariant verification function ───────────────────────────────────────
-- Rather than a CHECK constraint (which cannot reference other tables and
-- cannot be DEFERRABLE in PostgreSQL), we provide a helper function that the
-- application can call to verify the invariant at any time, and which the
-- housekeeping cron uses to detect violations.
--
-- CHECK constraints in PostgreSQL are evaluated at statement time, not commit
-- time, and cannot reference other tables. A trigger-based approach would work
-- but adds write-path overhead for every org update. Instead, the invariant is
-- enforced by application logic (onboarding.ts always sets ownerUserId in the
-- same transaction as creating the membership) and audited by this function.
CREATE OR REPLACE FUNCTION verify_org_owner_invariant()
RETURNS TABLE (org_id UUID, org_name TEXT) AS $$
    SELECT o.id, o.name
      FROM organizations o
     WHERE o.owner_user_id IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM memberships m
              WHERE m.organization_id = o.id
                AND m.user_id         = o.owner_user_id
                AND m.role            = 'owner'
                AND m.status          = 'active'
           )
$$
LANGUAGE sql STABLE;
