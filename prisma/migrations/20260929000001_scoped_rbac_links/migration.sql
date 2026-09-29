-- =============================================================================
-- Scoped RBAC (C7) — staff↔user cardinality, tenant guards, and the initial
-- FRONT_DESK branch set.
--
-- Design record: docs/scoped-rbac-assumption-audit.md. Four changes:
--
-- 1. staff_location_user_unique — at most one LINKED staff row per
--    (location, user). Deliberately NOT per organisation: a practitioner who
--    works at two locations of one organisation is modelled as two staff rows
--    (staff.location_id is single, availability has no location column, and
--    booking requires staff.location_id = appointment.location_id), and BOTH
--    must be linkable to that practitioner's account, or their bookings at the
--    second location stay unowned forever (audit §2). Partial on
--    user_id IS NOT NULL, so unlinked rows are unconstrained. Production has no
--    linked rows at all — nothing wrote staff.user_id before this release — and
--    the precondition below proves it rather than assuming it.
--
-- 2. staff_user_is_member — a staff row may only be linked to a user who holds
--    a membership in the SAME organisation. A cross-tenant link is refused by
--    the database, not only by the linking code.
--
-- 3. membership_branches_same_org — a membership may only be scoped to
--    branches of its OWN organisation. The RLS policy on membership_branches
--    checks the branch against the session's organisation but never compared
--    the branch with the membership's.
--
-- 4. Owner decision D1 — every FRONT_DESK membership with an EMPTY branch set
--    receives every branch of its organisation. From this release an empty set
--    means NO access (lib/rbac/can.ts 4b, lib/rbac/scope.ts scopedLocationIds);
--    before it, empty meant org-wide, and nothing ever wrote
--    membership_branches, so every receptionist has an empty set. Without this
--    backfill each of them would lose booking access at deploy. A membership
--    that already carries a scope is left exactly as it is. Backfilled rows are
--    stamped with a fixed created_at (below) so they can be told apart from
--    assignments an admin makes later.
--
-- ONE STATEMENT, NOT BEGIN/COMMIT. `prisma migrate deploy` does not wrap this
-- file in a transaction (see 20260921000001), so atomicity is this file's job.
-- The usual answer is an explicit BEGIN/COMMIT — but proven on a disposable
-- database, when a guard in such a block RAISEs, Prisma is left holding a
-- connection inside the ABORTED transaction block, reports only "current
-- transaction is aborted, commands ignored until end of transaction block",
-- and writes no logs to the ledger row. The refusal reason is lost, which is
-- the one thing an operator needs. The whole migration is therefore a single
-- DO statement: one statement is atomic on its own, a RAISE rolls back every
-- change it made, the connection is left clean, and the reason reaches the
-- migrate log verbatim. LOCK and SET LOCAL hold for that statement's
-- transaction, so every assertion and mutation still shares one locked
-- snapshot.
--
-- DEPLOY OVERLAP. migrate.yml and the Vercel deploy run from the same push in
-- parallel. Whichever lands first, there is a short window, and both are
-- fail-closed:
--   • migration first: the OLD code sees populated FRONT_DESK sets and compares
--     location ids with branch ids (audit §3.4), so receptionist MUTATIONS are
--     refused until the new code is live. Their lists still work.
--   • code first: the NEW code sees empty sets and shows receptionists nothing
--     until this backfill commits.
--   Neither order widens anyone's access.
--
-- ROLLBACK (the tested reverse). Roll the APPLICATION back first or together:
-- the previous code cannot read a populated FRONT_DESK set correctly, because
-- of the id-space defect this release fixes, so the only safe prior state for
-- FRONT_DESK is an EMPTY set — admin-made assignments included.
--
--   BEGIN;
--   DELETE FROM membership_branches mb
--    USING memberships m, roles r
--    WHERE mb.membership_id = m.id AND r.id = m.role_id AND r.key = 'FRONT_DESK';
--   DROP TRIGGER IF EXISTS membership_branches_same_org ON membership_branches;
--   DROP FUNCTION IF EXISTS membership_branches_same_org();
--   DROP TRIGGER IF EXISTS staff_user_is_member ON staff;
--   DROP FUNCTION IF EXISTS staff_user_is_member();
--   DROP INDEX IF EXISTS staff_location_user_unique;
--   COMMIT;
--
--   Staff links need no reverse: the previous code already reads
--   staff.user_id for `:own`, and reads it correctly.
-- =============================================================================

DO $migration$
DECLARE
  duplicate_links     INT;
  foreign_links       INT;
  foreign_scopes      INT;
  unscoped_front_desk INT;
BEGIN
  -- Fail fast rather than queue behind a long transaction; every table touched
  -- here is small, so an abort is a retry, not an incident.
  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '60s';

  -- Writers wait for the duration; readers continue. The branch set of every
  -- FRONT_DESK membership is decided from memberships, roles and branches,
  -- none of which may change underneath that decision.
  LOCK TABLE "membership_branches" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE "memberships" IN SHARE MODE;
  LOCK TABLE "roles" IN SHARE MODE;
  LOCK TABLE "branches" IN SHARE MODE;
  LOCK TABLE "staff" IN SHARE ROW EXCLUSIVE MODE;

  -- -------------------------------------------------------------------------
  -- ABORT BEFORE MUTATING on any state the new guards could not express.
  -- -------------------------------------------------------------------------
  SELECT count(*) INTO duplicate_links FROM (
    SELECT 1 FROM "staff"
     WHERE "user_id" IS NOT NULL
     GROUP BY "location_id", "user_id"
    HAVING count(*) > 1
  ) d;
  IF duplicate_links > 0 THEN
    RAISE EXCEPTION
      'refusing: % (location, user) pair(s) already have more than one linked staff row',
      duplicate_links;
  END IF;

  SELECT count(*) INTO foreign_links
    FROM "staff" s
   WHERE s."user_id" IS NOT NULL
     AND NOT EXISTS (
           SELECT 1 FROM "memberships" m
            WHERE m."organization_id" = s."organization_id" AND m."user_id" = s."user_id");
  IF foreign_links > 0 THEN
    RAISE EXCEPTION
      'refusing: % staff row(s) are linked to a user with no membership in their organisation',
      foreign_links;
  END IF;

  SELECT count(*) INTO foreign_scopes
    FROM "membership_branches" mb
    JOIN "memberships" m ON m."id" = mb."membership_id"
    JOIN "branches" b    ON b."id" = mb."branch_id"
   WHERE b."organization_id" <> m."organization_id";
  IF foreign_scopes > 0 THEN
    RAISE EXCEPTION
      'refusing: % membership_branches row(s) scope a membership to another organisation''s branch',
      foreign_scopes;
  END IF;

  -- -------------------------------------------------------------------------
  -- 1. One linked staff row per (location, user).
  -- -------------------------------------------------------------------------
  CREATE UNIQUE INDEX "staff_location_user_unique"
      ON "staff" ("location_id", "user_id")
   WHERE "user_id" IS NOT NULL;

  -- -------------------------------------------------------------------------
  -- 2. A link must stay inside the staff row's organisation.
  --
  --    Runs as the invoking role. Through the app role the membership lookup
  --    is itself filtered by RLS to the session's organisation, which can only
  --    make the check stricter.
  -- -------------------------------------------------------------------------
  CREATE OR REPLACE FUNCTION staff_user_is_member() RETURNS trigger AS $fn$
  BEGIN
      IF NEW.user_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "memberships" m
           WHERE m.organization_id = NEW.organization_id
             AND m.user_id = NEW.user_id
      ) THEN
          RAISE EXCEPTION
              'staff % cannot be linked to user %: no membership in organisation %',
              NEW.id, NEW.user_id, NEW.organization_id
              USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;

  CREATE TRIGGER staff_user_is_member
      BEFORE INSERT OR UPDATE OF user_id, organization_id ON "staff"
      FOR EACH ROW EXECUTE FUNCTION staff_user_is_member();

  -- -------------------------------------------------------------------------
  -- 3. A branch scope must stay inside the membership's organisation.
  -- -------------------------------------------------------------------------
  CREATE OR REPLACE FUNCTION membership_branches_same_org() RETURNS trigger AS $fn$
  BEGIN
      IF NOT EXISTS (
          SELECT 1
            FROM "memberships" m
            JOIN "branches" b ON b.organization_id = m.organization_id
           WHERE m.id = NEW.membership_id
             AND b.id = NEW.branch_id
      ) THEN
          RAISE EXCEPTION
              'membership % cannot be scoped to branch %: not in the same organisation',
              NEW.membership_id, NEW.branch_id
              USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;

  CREATE TRIGGER membership_branches_same_org
      BEFORE INSERT OR UPDATE ON "membership_branches"
      FOR EACH ROW EXECUTE FUNCTION membership_branches_same_org();

  -- -------------------------------------------------------------------------
  -- 4. D1 — every FRONT_DESK membership with no scope gets every branch of its
  --    organisation. Keyed on the system FRONT_DESK role through role_id, the
  --    authoritative pointer; memberships with any existing scope are
  --    untouched. The fixed created_at marks these rows as the backfill.
  -- -------------------------------------------------------------------------
  INSERT INTO "membership_branches" ("membership_id", "branch_id", "created_at")
  SELECT m."id", b."id", TIMESTAMPTZ '2026-09-29 00:00:00+00'
    FROM "memberships" m
    JOIN "roles" r    ON r."id" = m."role_id"
                     AND r."key" = 'FRONT_DESK'
                     AND r."organization_id" IS NULL
    JOIN "branches" b ON b."organization_id" = m."organization_id"
   WHERE NOT EXISTS (
           SELECT 1 FROM "membership_branches" x WHERE x."membership_id" = m."id")
  ON CONFLICT DO NOTHING;

  -- -------------------------------------------------------------------------
  -- POSTCONDITIONS. Assert rather than hope; a RAISE here undoes all of the
  -- above, because it is all one statement.
  -- -------------------------------------------------------------------------
  -- No FRONT_DESK membership may be left with an empty set in an organisation
  -- that has branches: that receptionist would lose access at deploy.
  SELECT count(*) INTO unscoped_front_desk
    FROM "memberships" m
    JOIN "roles" r ON r."id" = m."role_id" AND r."key" = 'FRONT_DESK' AND r."organization_id" IS NULL
   WHERE EXISTS (SELECT 1 FROM "branches" b WHERE b."organization_id" = m."organization_id")
     AND NOT EXISTS (SELECT 1 FROM "membership_branches" x WHERE x."membership_id" = m."id");
  IF unscoped_front_desk > 0 THEN
    RAISE EXCEPTION 'backfill incomplete: % FRONT_DESK membership(s) still have no branch',
      unscoped_front_desk;
  END IF;

  SELECT count(*) INTO foreign_scopes
    FROM "membership_branches" mb
    JOIN "memberships" m ON m."id" = mb."membership_id"
    JOIN "branches" b    ON b."id" = mb."branch_id"
   WHERE b."organization_id" <> m."organization_id";
  IF foreign_scopes > 0 THEN
    RAISE EXCEPTION 'backfill produced % cross-organisation scope row(s)', foreign_scopes;
  END IF;
END
$migration$;
