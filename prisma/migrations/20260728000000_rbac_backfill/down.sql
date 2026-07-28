-- Rollback for 20260728000000_rbac_backfill.
--
-- Undoes every step of the forward migration, keyed on stable inverse
-- conditions so it can be re-run safely. Runs before the sync-triggers
-- rollback (see docs/rbac-migration-runbook.md — rollback order matters:
-- drop triggers first so app writes don't immediately re-fill the columns).
--
-- Prisma does not run down.sql automatically. Apply this via psql or via
-- `scripts/rbac-backfill.ts rollback`.

-- 7. Undo platform role seed.
UPDATE "app_users"
   SET platform_role_id = NULL,
       mfa_enabled = FALSE
 WHERE email = 'levaaani@gmail.com'
   AND platform_role_id = (
         SELECT id FROM "roles"
          WHERE key = 'SUPER_ADMIN' AND organization_id IS NULL
       );

-- 6. is_bookable back to default false for the rows the backfill flipped.
--    We can't distinguish backfill-set from human-set values, but at rollback
--    time no human-set values exist (Phase 4 hasn't shipped) — so reversing
--    the exact rule is safe.
UPDATE "memberships"
   SET is_bookable = FALSE
 WHERE role IN ('owner','practitioner')
   AND is_bookable = TRUE;

-- 5. joined_at back to NULL wherever it equals created_at (which is what
--    the backfill set it to). Any Phase 6+ accept-invitation flow that sets
--    joined_at to a later value is left alone.
UPDATE "memberships"
   SET joined_at = NULL
 WHERE joined_at = created_at;

-- 4. role_id back to NULL for the three system roles the backfill assigned.
UPDATE "memberships"
   SET role_id = NULL
 WHERE role_id IN (
        SELECT id FROM "roles"
         WHERE organization_id IS NULL
           AND key IN ('ORG_OWNER','PROVIDER','FRONT_DESK')
       );

-- 3. owner_user_id back to NULL. Same safety argument as is_bookable: no
--    human-set owner_user_id exists yet.
UPDATE "organizations"
   SET owner_user_id = NULL
 WHERE owner_user_id IS NOT NULL;

-- 2. Delete the branches rows created by the backfill (identified by
--    legacy_location_id NOT NULL — no other code creates branches yet).
--    membership_branches would CASCADE, but none exist pre-Phase-4.
DELETE FROM "branches"
 WHERE legacy_location_id IS NOT NULL;

-- 1. vertical back to NULL.
UPDATE "organizations"
   SET vertical = NULL
 WHERE vertical IS NOT NULL;
