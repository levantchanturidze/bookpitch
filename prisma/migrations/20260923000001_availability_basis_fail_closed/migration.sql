-- Post-cutover fail-closed invariant for staff_availability.time_basis.
--
-- Stage D converted every legacy row and moved the default to 'local'. That
-- left two ways a wrong-meaning row could still appear, both silent:
--
--   1. A stale writer inserts or updates a row as 'utc_legacy'. Today every
--      reader handles that correctly, so it is not corruption — but the column
--      exists to be removed eventually, and a legacy row surviving into that
--      moment would be read as local and enforced four hours out.
--
--   2. A future writer produces UTC bytes and OMITS the marker. The default
--      then labels them 'local' and nothing anywhere disagrees. This is the
--      dangerous one: it needs no stale instance, only a regression that
--      reintroduces the conversion and forgets the label, which is exactly the
--      shape this project keeps finding.
--
-- Both are closed here:
--
--   * the CHECK is narrowed to 'local' only, so a legacy write ERRORS instead
--     of quietly succeeding;
--   * the DEFAULT is DROPPED, so an omitted marker errors instead of being
--     guessed. With @default removed from schema.prisma this also becomes a
--     TypeScript requirement — a writer that forgets the basis now fails to
--     compile, which is the earliest possible place to catch it.
--
-- Provenance must be stated, never inherited. That was the principle the whole
-- rollout was built on; this is the last place the database still allowed it to
-- be inherited.
--
-- ROLLBACK TARGET. Stage C (ccd8cee) remains the safe application rollback and
-- writes explicit 'local', so it is unaffected. Stage B wrote explicit
-- 'utc_legacy' and would now fail — it has not been a valid rollback target
-- since Stage D landed, and this makes that explicit rather than implicit.
--
-- Dual-READ support stays in the application through certification. This
-- constrains what may be WRITTEN, not what can be read.
--
-- ATOMICITY IS THIS FILE'S JOB. `prisma migrate deploy` does not wrap
-- migration.sql in a transaction — proven on 7.9.1 — so the guard, the
-- constraint swap and the default drop are one explicit transaction. A failure
-- anywhere rolls all of it back.
--
-- ROLLBACK SQL:
--   ALTER TABLE "staff_availability" ALTER COLUMN "time_basis" SET DEFAULT 'local';
--   ALTER TABLE "staff_availability"
--     DROP CONSTRAINT "staff_availability_time_basis_check";
--   ALTER TABLE "staff_availability"
--     ADD CONSTRAINT "staff_availability_time_basis_check"
--     CHECK ("time_basis" IN ('local', 'utc_legacy'));

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE "staff_availability" IN SHARE ROW EXCLUSIVE MODE;

-- FAIL CLOSED. Narrowing the constraint while a legacy row exists would abort
-- on the constraint itself with a message about validation rather than about
-- the actual problem. Check first and say what is wrong.
DO $$
DECLARE
  legacy INT;
BEGIN
  SELECT count(*) INTO legacy
    FROM "staff_availability" WHERE "time_basis" <> 'local';
  IF legacy > 0 THEN
    RAISE EXCEPTION
      'refusing to narrow time_basis: % row(s) are still not local. Run the '
      'Stage D backfill (20260921000001) first.', legacy;
  END IF;
END $$;

ALTER TABLE "staff_availability"
  DROP CONSTRAINT IF EXISTS "staff_availability_time_basis_check";
ALTER TABLE "staff_availability"
  ADD CONSTRAINT "staff_availability_time_basis_check"
  CHECK ("time_basis" = 'local');

-- An omitted marker is now an error, not a guess.
ALTER TABLE "staff_availability" ALTER COLUMN "time_basis" DROP DEFAULT;

COMMIT;
