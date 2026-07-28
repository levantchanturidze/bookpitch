-- =============================================================================
-- RBAC Phase 2 — backfill historical rows into the new spec §3 columns.
--
-- This is the single-window backfill. Prod is effectively pre-launch (Phase 0
-- Q1, docs/rbac-discovery.md §9): 2 users, 1 org, 0 customers, 0 appointments,
-- so we skip the spec-prompt's dual-write scheme and run one transactional
-- migration under a maintenance window.
--
-- Post-cutover drift is prevented by the sync-triggers migration
-- (20260728000100_rbac_sync_triggers) which runs immediately after this one.
--
-- Every step is idempotent (WHERE new_col IS NULL / DO NOTHING). Re-running
-- this migration on already-backfilled rows is a no-op. Prisma migrations run
-- inside a single transaction — if any step fails, the whole file rolls back
-- and the migration is not recorded in _prisma_migrations.
--
-- Order (per docs/rbac-schema-notes.md §5.1):
--   1. organizations.vertical         from majority locations.type per org
--   2. branches                        one per locations row
--   3. organizations.owner_user_id     first membership with role='owner'
--   4. memberships.role_id             lookup by role enum → roles.key
--   5. memberships.joined_at           copy created_at
--   6. memberships.is_bookable         true for owner + practitioner
--   7. platform role for levaaani@gmail.com (SUPER_ADMIN, mfa_enabled)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. organizations.vertical ← majority locations.type per org, or 'mixed'
--    when >1 distinct type is present.
--
--    Rationale: the current LocationType enum has values 'clinic' and 'salon'.
--    An org with only clinic locations gets 'clinic'; only salon → 'salon';
--    a mix → 'mixed'. Orgs with zero locations are left NULL (nothing to
--    seed from) — the sync trigger on the first location insert will fill it.
-- -----------------------------------------------------------------------------
WITH org_types AS (
    SELECT organization_id,
           array_agg(DISTINCT type::text ORDER BY type::text) AS types
      FROM "locations"
     GROUP BY organization_id
)
UPDATE "organizations" o
   SET vertical = CASE
                    WHEN array_length(ot.types, 1) = 1 THEN ot.types[1]
                    ELSE 'mixed'
                  END
  FROM org_types ot
 WHERE o.id = ot.organization_id
   AND o.vertical IS NULL;

-- -----------------------------------------------------------------------------
-- 2. branches ← one row per locations row.
--
--    legacy_location_id is the back-pointer + the idempotency key. The
--    partial unique index (branches_legacy_location_id_unique from Phase 1)
--    turns any re-run into a DO NOTHING.
-- -----------------------------------------------------------------------------
INSERT INTO "branches" (organization_id, name, timezone, legacy_location_id)
SELECT l.organization_id, l.name, l.timezone, l.id
  FROM "locations" l
  LEFT JOIN "branches" b ON b.legacy_location_id = l.id
 WHERE b.id IS NULL;

-- -----------------------------------------------------------------------------
-- 3. organizations.owner_user_id ← first membership (role='owner') by
--    created_at. Ties broken by membership id for determinism.
--
--    Only touches orgs where owner_user_id IS NULL. If an org has zero owner
--    memberships today (shouldn't happen per Phase 0 §4 checks, but the
--    invariant isn't yet enforced at write time), it stays NULL and Step 7
--    of the verification script will flag it.
-- -----------------------------------------------------------------------------
WITH first_owner AS (
    SELECT DISTINCT ON (organization_id)
           organization_id, user_id
      FROM "memberships"
     WHERE role = 'owner'
     ORDER BY organization_id, created_at, id
)
UPDATE "organizations" o
   SET owner_user_id = fo.user_id
  FROM first_owner fo
 WHERE o.id = fo.organization_id
   AND o.owner_user_id IS NULL;

-- -----------------------------------------------------------------------------
-- 4. memberships.role_id ← lookup by the exact key mapping from
--    prisma/rbac-seed.ts::SYSTEM_ROLES.
--
--    Uses a CTE to make the mapping explicit; UPDATE ... FROM ensures a
--    single scan and stays readable.
-- -----------------------------------------------------------------------------
WITH role_map AS (
    SELECT enumval, r.id AS role_id
      FROM (VALUES
              ('owner'::user_role,        'ORG_OWNER'),
              ('practitioner'::user_role, 'PROVIDER'),
              ('receptionist'::user_role, 'FRONT_DESK')
           ) AS m(enumval, key)
      JOIN "roles" r ON r.key = m.key AND r.organization_id IS NULL
)
UPDATE "memberships" m
   SET role_id = rm.role_id
  FROM role_map rm
 WHERE m.role = rm.enumval
   AND m.role_id IS NULL;

-- -----------------------------------------------------------------------------
-- 5. memberships.joined_at ← created_at when NULL.
-- -----------------------------------------------------------------------------
UPDATE "memberships"
   SET joined_at = created_at
 WHERE joined_at IS NULL;

-- -----------------------------------------------------------------------------
-- 6. memberships.is_bookable ← true for the roles that were bookable under
--    the old model (owner + practitioner). Phase 1 default is false; we
--    only flip rows that fit the rule and are still at the default. Front-desk
--    is left false. Editable per-membership by Phase 6.
-- -----------------------------------------------------------------------------
UPDATE "memberships"
   SET is_bookable = TRUE
 WHERE role IN ('owner','practitioner')
   AND is_bookable = FALSE;

-- -----------------------------------------------------------------------------
-- 7. Platform role for levaaani@gmail.com (Phase 0 Q9).
--
--    Silent skip if the row doesn't exist yet — production may not have this
--    account until first signup. In that case the manual UPDATE documented
--    in docs/rbac-migration-runbook.md is the follow-up.
--
--    citext-safe: email column is CITEXT (see 20260721220810_init).
-- -----------------------------------------------------------------------------
UPDATE "app_users"
   SET platform_role_id = (
         SELECT id FROM "roles"
          WHERE key = 'SUPER_ADMIN' AND organization_id IS NULL
       ),
       mfa_enabled = TRUE
 WHERE email = 'levaaani@gmail.com'
   AND platform_role_id IS NULL;
