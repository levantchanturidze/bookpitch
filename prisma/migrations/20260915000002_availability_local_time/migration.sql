-- 5.3 — move staff availability to the LOCATION'S LOCAL wall clock.
--
-- WHY. components/settings/actions.ts stored the LOCAL weekday beside times
-- converted to UTC by localHHMMToUtcHHMM(), while
-- lib/appointments.ts::assertWithinAvailability() read the UTC weekday and the
-- UTC time. Those agree only while the conversion does not cross midnight; when
-- it does, the time wraps and the weekday does not, so the window is filed
-- against the wrong day.
--
-- PROVENANCE, NOT GUESSWORK. The previous draft of this migration rewrote every
-- row unconditionally. That is unsafe: re-running it would convert twice, and a
-- row already written in local time would be corrupted. `time_basis` is an
-- explicit data-version boundary. Rows that exist when this migration runs
-- predate the local model by definition and are marked 'utc_legacy'; only those
-- are converted; the column then reads 'local' for every row, and the
-- application writes 'local' from here on. Converting twice is impossible
-- because the second pass matches nothing.
--
-- PRODUCTION PRECONDITION (verified read-only before deployment): five rows,
-- one staff member, Asia/Tbilisi, weekdays 1-5, stored 05:00-13:00, intended
-- 09:00-17:00 local. 05:00Z in Asia/Tbilisi is 09:00 and 13:00Z is 17:00, so
-- the conversion below reproduces the intended schedule exactly.
--
-- TIMEZONE ANCHOR. 2026-01-01, never the column's 1970 epoch: Tbilisi was
-- UTC+3 in 1970 and is UTC+4 now, so a 1970 anchor would be an hour out on
-- every row. IANA semantics via AT TIME ZONE, not a hard-coded offset.
--
-- FRESH DATABASES. On an empty database every statement below is a no-op and
-- the seed then inserts local rows with the default basis. CI exercises exactly
-- that path.
--
-- DEVELOPER DATABASES. prisma/seed.ts historically wrote raw digits, which
-- already meant local. Those rows are indistinguishable from legacy rows here
-- and will be shifted. Re-seed after upgrading a long-lived dev database;
-- production has no seeded availability, only editor-written rows.
--
-- ROLLBACK:
--   UPDATE staff_availability sa
--      SET start_time = ((DATE '2026-01-01' + sa.start_time) AT TIME ZONE l.timezone
--                          AT TIME ZONE 'UTC')::time,
--          end_time   = ((DATE '2026-01-01' + sa.end_time)   AT TIME ZONE l.timezone
--                          AT TIME ZONE 'UTC')::time
--     FROM staff s JOIN locations l ON l.id = s.location_id
--    WHERE sa.staff_id = s.id;
--   ALTER TABLE staff_availability DROP COLUMN time_basis;
--   ALTER TABLE staff DROP COLUMN availability_configured_at;
-- Expand-only: both columns are additive and the rewrite is value-preserving,
-- so the pre-migration build keeps serving while a roll-forward is prepared.

ALTER TABLE "staff"
  ADD COLUMN IF NOT EXISTS "availability_configured_at" TIMESTAMPTZ(6);

-- The column is created with DEFAULT 'utc_legacy', so ADD COLUMN itself marks
-- exactly the rows that already existed — the ones that predate the local
-- model. The default is flipped to 'local' after the conversion, below.
--
-- This is what makes double conversion IMPOSSIBLE rather than merely unlikely.
-- An earlier draft marked rows with an unconditional
-- `UPDATE ... SET time_basis = 'utc_legacy'`, which on any second execution
-- would have re-marked already-converted rows and shifted them again. Here a
-- second execution finds the column present (ADD COLUMN IF NOT EXISTS is a
-- no-op), no rows in 'utc_legacy', and nothing to convert.
ALTER TABLE "staff_availability"
  ADD COLUMN IF NOT EXISTS "time_basis" TEXT NOT NULL DEFAULT 'utc_legacy';

ALTER TABLE "staff_availability"
  DROP CONSTRAINT IF EXISTS "staff_availability_time_basis_check";
ALTER TABLE "staff_availability"
  ADD CONSTRAINT "staff_availability_time_basis_check"
  CHECK ("time_basis" IN ('local', 'utc_legacy'));

-- Everything written from here on is local. The column was created with
-- DEFAULT 'utc_legacy' so that ADD COLUMN itself marked exactly the rows that
-- already existed; flipping the default now means new writes are labelled
-- correctly without a second UPDATE touching anything.
ALTER TABLE "staff_availability" ALTER COLUMN "time_basis" SET DEFAULT 'local';

-- NO VALUES ARE REWRITTEN HERE, DELIBERATELY.
--
-- migrate.yml applies migrations on push to main while Vercel deploys from the
-- same push IN PARALLEL, so the PREVIOUS release serves for a minute or two
-- against this schema. If this migration rewrote 05:00 into 09:00, that build —
-- which still reads the column as UTC — would enforce every window four hours
-- out; and an availability save during the window would write a UTC value into
-- a column now defaulting to 'local', mislabelling it at birth and then
-- protecting it from correction by the very marker meant to prevent double
-- conversion.
--
-- So legacy rows keep the exact bytes the old build expects. lib/availability-basis.ts
-- teaches the new build to read both bases, which makes the overlap a
-- non-event. Normalising the legacy rows to 'local' is a separate, guarded step
-- that can run once the old build is drained, and nothing depends on when.

-- Staff who already have windows were configured by somebody, so the day-off
-- semantics apply to them. Staff with none keep NULL and the legacy
-- fall-through, which lib/appointments.ts documents.
UPDATE "staff" s
   SET "availability_configured_at" = NOW()
 WHERE EXISTS (SELECT 1 FROM "staff_availability" sa WHERE sa."staff_id" = s."id");
