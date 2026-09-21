-- STAGE D of four: convert the remaining legacy availability rows, then move
-- the column default. The last step of the UTC -> local rollout.
--
-- PRECONDITION, and it is not rhetorical. Stage C (ccd8cee) is deployed on both
-- canonical hosts and every Stage B instance — which wrote explicit
-- 'utc_legacy' — has drained. So no writer can add a legacy row while this
-- runs, and the set being converted is closed.
--
-- WHAT IS CONVERTED, AND WHAT IS DELIBERATELY NOT.
--
-- Legacy rows hold a LOCAL weekday beside a UTC time-of-day. That inconsistency
-- is the original defect: the editor wrote the local weekday and converted only
-- the times. So the backfill converts the TIME and leaves `weekday` alone.
-- Shifting the weekday as well would move every window by a day.
--
-- The case that cannot be converted this way is a window whose UTC form
-- straddles local midnight: 19:00-23:00 UTC in Asia/Tbilisi becomes
-- 23:00-03:00, and an end before its start is not a window. Splitting it across
-- two weekdays is a product decision, not a data fix, so this ABORTS instead.
-- scripts/availability-backfill-preflight.sql prints `would_invert` before
-- anything applies, so the case is visible in the run log rather than
-- discovered here.
--
-- ATOMICITY IS THIS FILE'S JOB, NOT PRISMA'S.
--
-- `prisma migrate deploy` does NOT wrap migration.sql in a transaction. Proven
-- on 7.9.1 against a disposable database: a file that created a table, inserted
-- a row and then divided by zero left the table AND the row behind, with the
-- ledger row finished_at=NULL, rolled_back_at=NULL (P3018).
--
-- An earlier revision of this file assumed the opposite. The assumption held in
-- testing only because the harness ran `psql --single-transaction`, which
-- supplied a transaction the real command never does — the harness was proving
-- a property of itself. Without an explicit BEGIN the UPDATE below would
-- autocommit and a failing postcondition could not undo it, leaving production
-- half-converted with the default still legacy.
--
-- So the whole critical section is one explicit transaction, following the
-- convention 20260723000008_audit_partition already set in this repository.
--
-- CONCURRENCY. Inside that transaction:
--   * lock_timeout bounds the wait for the lock — failing to acquire it aborts
--     rather than blocking production writes indefinitely;
--   * statement_timeout bounds the conversion itself;
--   * staff_availability is locked SHARE ROW EXCLUSIVE (writers wait, readers
--     continue);
--   * staff and locations are locked SHARE, because `locations.timezone` is the
--     input to every conversion — a timezone edited mid-migration would convert
--     some rows with one offset and some with another.
-- Every assertion and the mutation therefore share one locked snapshot.
--
-- IDEMPOTENT. A second execution finds no 'utc_legacy' rows: the UPDATE matches
-- nothing, every guard passes trivially, and SET DEFAULT is already what it is
-- being set to. `prisma migrate deploy` will not re-run an applied migration at
-- all; this property matters for the failure case, where the ledger row is left
-- unfinished and the migration is re-attempted after resolution.
--
-- ROLLBACK (only meaningful before the application stops reading both bases):
--   ALTER TABLE "staff_availability" ALTER COLUMN "time_basis" SET DEFAULT 'utc_legacy';
--   UPDATE staff_availability sa
--      SET start_time = ((DATE '2026-01-01' + sa.start_time) AT TIME ZONE l.timezone
--                          AT TIME ZONE 'UTC')::time,
--          end_time   = ((DATE '2026-01-01' + sa.end_time)   AT TIME ZONE l.timezone
--                          AT TIME ZONE 'UTC')::time,
--          time_basis = 'utc_legacy'
--     FROM staff s JOIN locations l ON l.id = s.location_id
--    WHERE sa.staff_id = s.id AND sa.time_basis = 'local';
-- Note this would also relabel rows the application wrote as local. Prefer
-- rolling FORWARD; dual-read support stays in the application through the soak
-- precisely so that rolling back is never the only option.

BEGIN;

-- Fail fast instead of queueing behind a long transaction. 5s is far longer
-- than any availability write, and an abort here is a retry, not an incident.
SET LOCAL lock_timeout = '5s';
-- The conversion touches a handful of rows; a minute is generous. Bounding it
-- means a pathological plan cannot hold these locks indefinitely.
SET LOCAL statement_timeout = '60s';

LOCK TABLE "staff_availability" IN SHARE ROW EXCLUSIVE MODE;
-- The timezone source. Read-only here, but it must not change underneath the
-- conversion, so writers are excluded for the duration.
LOCK TABLE "staff" IN SHARE MODE;
LOCK TABLE "locations" IN SHARE MODE;

-- ---------------------------------------------------------------------------
-- ABORT BEFORE MUTATING on anything the conversion cannot express honestly.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  no_tz        INT;
  unknown_tz   INT;
  inverting    INT;
  colliding    INT;
BEGIN
  -- A legacy row whose location has no usable timezone cannot be converted, and
  -- guessing UTC would silently shift a real schedule.
  SELECT count(*) INTO no_tz
    FROM "staff_availability" sa
    JOIN "staff" s ON s.id = sa.staff_id
    LEFT JOIN "locations" l ON l.id = s.location_id
   WHERE sa.time_basis = 'utc_legacy'
     AND (l.timezone IS NULL OR btrim(l.timezone) = '');
  IF no_tz > 0 THEN
    RAISE EXCEPTION 'refusing backfill: % legacy row(s) have no location timezone', no_tz;
  END IF;

  -- Every timezone actually present must be one PostgreSQL recognises. An
  -- unrecognised name makes AT TIME ZONE raise mid-statement, which would be a
  -- failure discovered halfway through rather than refused up front.
  SELECT count(*) INTO unknown_tz
    FROM "staff_availability" sa
    JOIN "staff" s ON s.id = sa.staff_id
    JOIN "locations" l ON l.id = s.location_id
   WHERE sa.time_basis = 'utc_legacy'
     AND NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = l.timezone);
  IF unknown_tz > 0 THEN
    RAISE EXCEPTION
      'refusing backfill: % legacy row(s) name a timezone this server does not know', unknown_tz;
  END IF;

  -- A window that would end at or before it starts. See the header: splitting
  -- it across weekdays is a product decision, not a data fix.
  SELECT count(*) INTO inverting
    FROM "staff_availability" sa
    JOIN "staff" s ON s.id = sa.staff_id
    JOIN "locations" l ON l.id = s.location_id
   WHERE sa.time_basis = 'utc_legacy'
     AND ((DATE '2026-01-01' + sa.end_time) AT TIME ZONE 'UTC' AT TIME ZONE l.timezone)::time
         <= ((DATE '2026-01-01' + sa.start_time) AT TIME ZONE 'UTC' AT TIME ZONE l.timezone)::time;
  IF inverting > 0 THEN
    RAISE EXCEPTION
      'refusing backfill: % legacy window(s) straddle local midnight and would invert. '
      'Split them across weekdays in the product first.', inverting;
  END IF;

  -- Converting must not make two windows on one weekday overlap. Shifting every
  -- row on a day by the same offset preserves ordering, so this can only fire
  -- where a legacy row meets an already-local row for the same staff member and
  -- weekday — a mixed-basis day, which Stage B and C overlap can produce.
  WITH converted AS (
    SELECT sa.id, sa.staff_id, sa.weekday,
           CASE WHEN sa.time_basis = 'local' THEN sa.start_time
                ELSE ((DATE '2026-01-01' + sa.start_time) AT TIME ZONE 'UTC'
                        AT TIME ZONE l.timezone)::time END AS s,
           CASE WHEN sa.time_basis = 'local' THEN sa.end_time
                ELSE ((DATE '2026-01-01' + sa.end_time) AT TIME ZONE 'UTC'
                        AT TIME ZONE l.timezone)::time END AS e
      FROM "staff_availability" sa
      JOIN "staff" s ON s.id = sa.staff_id
      JOIN "locations" l ON l.id = s.location_id
  )
  SELECT count(*) INTO colliding
    FROM converted a JOIN converted b
      ON b.staff_id = a.staff_id AND b.weekday = a.weekday AND b.id <> a.id
     AND a.s < b.e AND b.s < a.e;
  IF colliding > 0 THEN
    RAISE EXCEPTION
      'refusing backfill: conversion would create % overlapping window pair(s)', colliding;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Convert. Value and basis move together in one statement, so no row can exist
-- with converted digits and a legacy marker. Already-local rows are untouched
-- by the WHERE clause.
-- ---------------------------------------------------------------------------
UPDATE "staff_availability" sa
   SET "start_time" = ((DATE '2026-01-01' + sa."start_time") AT TIME ZONE 'UTC'
                         AT TIME ZONE l."timezone")::time,
       "end_time"   = ((DATE '2026-01-01' + sa."end_time")   AT TIME ZONE 'UTC'
                         AT TIME ZONE l."timezone")::time,
       "time_basis" = 'local'
  FROM "staff" s
  JOIN "locations" l ON l."id" = s."location_id"
 WHERE sa."staff_id" = s."id"
   AND sa."time_basis" = 'utc_legacy';

-- ---------------------------------------------------------------------------
-- POSTCONDITIONS. Assert rather than hope.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  leftover    INT;
  inverted    INT;
  overlapping INT;
BEGIN
  SELECT count(*) INTO leftover
    FROM "staff_availability" WHERE "time_basis" <> 'local';
  IF leftover > 0 THEN
    RAISE EXCEPTION 'backfill incomplete: % row(s) are still not local', leftover;
  END IF;

  SELECT count(*) INTO inverted
    FROM "staff_availability" WHERE "end_time" <= "start_time";
  IF inverted > 0 THEN
    RAISE EXCEPTION 'backfill produced % window(s) ending at or before their start', inverted;
  END IF;

  SELECT count(*) INTO overlapping
    FROM "staff_availability" a
    JOIN "staff_availability" b
      ON b."staff_id" = a."staff_id" AND b."weekday" = a."weekday" AND b."id" <> a."id"
     AND a."start_time" < b."end_time" AND b."start_time" < a."end_time";
  IF overlapping > 0 THEN
    RAISE EXCEPTION 'backfill produced % overlapping window pair(s)', overlapping;
  END IF;
END $$;

-- Only now, with every row local and verified, does the default follow. Doing
-- this in Stage A would have mislabelled an in-flight write from the old build
-- as local while its bytes were UTC — the hazard the whole rollout is shaped
-- around.
ALTER TABLE "staff_availability" ALTER COLUMN "time_basis" SET DEFAULT 'local';

COMMIT;
