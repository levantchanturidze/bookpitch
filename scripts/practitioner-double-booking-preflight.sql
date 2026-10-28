-- ---------------------------------------------------------------------------
-- Read-only preflight for 20261017000001_practitioner_double_booking.
--
-- One question, asked before the migration applies: is anyone ALREADY booked in
-- two places at once? The migration installs triggers, and a trigger judges
-- writes, not the rows already there. An upcoming overlap that exists today
-- survives the apply, and invariant check 9c then fails the deploy
-- verification immediately afterwards. This finds it first.
--
-- Run it BEFORE merging the PR. Merging IS the apply: migrate.yml runs on the
-- push to main. migrate.yml also runs it again, before "Apply migrations", so
-- the run log records the state the migration was applied against.
--
-- COUNTS ONLY. No appointment, staff, customer, user or organisation
-- identifier, no name and no time leaves the database. A non-zero result is
-- resolved with the organisation through the product, not from a log.
--
-- The overlap definition is check 9c's, character for character, so the
-- preflight and the post-apply verifier cannot disagree about a row.
--
-- Read-only by construction: the session is pinned read-only on the first
-- line. RUN IT WITH `psql -f`, NEVER `psql -c` (the pin sets the default for
-- SUBSEQUENT transactions; see scripts/verify-production-invariants.sql).
-- NOT in the Supabase SQL editor: `\set` and `\echo` below are psql
-- meta-commands, which a web SQL editor rejects. The operator procedure is in
-- docs/practitioner-double-booking.md.
-- ---------------------------------------------------------------------------

SET default_transaction_read_only = on;
SET statement_timeout = '60s';

\set ON_ERROR_STOP on

\echo '=== practitioner double-booking preflight (counts only) ==='

-- Is the guard already installed? 2 means the migration has applied.
SELECT count(*) AS guard_triggers_present
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal
   AND ((c.relname = 'appointments' AND t.tgname = 'appointments_practitioner_no_overlap')
     OR (c.relname = 'staff' AND t.tgname = 'staff_link_no_practitioner_overlap'));

-- Exposure: people with more than one staff row in one organisation. Only they
-- can be double-booked across rows. Context, not a verdict.
SELECT count(*) AS practitioners_with_several_staff_rows
  FROM (SELECT organization_id, user_id
          FROM staff
         WHERE user_id IS NOT NULL
         GROUP BY organization_id, user_id
        HAVING count(*) > 1) multi;

-- The verdict. Check 9c's predicate.
WITH pairs AS (
  SELECT a.organization_id, sa.user_id
    FROM appointments a
    JOIN staff sa ON sa.id = a.staff_id AND sa.user_id IS NOT NULL
    JOIN appointments b ON b.organization_id = a.organization_id
                       AND b.id > a.id
                       AND b.staff_id <> a.staff_id
                       AND b.status <> 'cancelled'
                       AND b.starts_at < a.ends_at AND b.ends_at > a.starts_at
    JOIN staff sb ON sb.id = b.staff_id AND sb.user_id = sa.user_id
   WHERE a.status <> 'cancelled'
     -- Upcoming: the overlap itself has not ended (both bookings end later).
     AND a.ends_at > now() AND b.ends_at > now()
)
SELECT count(*)                                    AS upcoming_overlapping_pairs,
       count(DISTINCT (organization_id, user_id))  AS practitioners_affected,
       count(DISTINCT organization_id)             AS organisations_affected,
       CASE WHEN count(*) = 0
            THEN 'PASS: nobody is booked in two places'
            ELSE 'RESOLVE FIRST: someone is booked in two places; check 9c will fail after the apply'
       END                                         AS verdict
  FROM pairs;
