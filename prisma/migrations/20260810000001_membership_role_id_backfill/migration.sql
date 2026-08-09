-- Re-apply role_id backfill for memberships created after the Phase 3 RBAC
-- rebuild. The original backfill (20260728000000_rbac_backfill) set role_id
-- from the role enum for all rows that existed at that time. Memberships
-- created since (via acceptInvitation / activatePendingRegistration) had
-- role_id = NULL, causing buildOrgContext to return null and blocking sign-in.
--
-- This migration is idempotent: WHERE role_id IS NULL means it only touches
-- rows that still need the fix.

WITH role_map AS (
  SELECT
    m.enumval,
    r.id AS role_id
  FROM (VALUES
          ('owner'::user_role,        'ORG_OWNER'),
          ('practitioner'::user_role, 'PROVIDER'),
          ('receptionist'::user_role, 'FRONT_DESK')
       ) AS m(enumval, key)
  JOIN "roles" r ON r.key = m.key AND r.organization_id IS NULL
)
UPDATE "memberships" mem
   SET role_id = rm.role_id
  FROM role_map rm
 WHERE mem.role = rm.enumval
   AND mem.role_id IS NULL;
