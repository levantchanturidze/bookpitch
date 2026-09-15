-- 5.3 — store staff availability in the LOCATION'S LOCAL time.
--
-- Before this, components/settings/actions.ts wrote the LOCAL weekday next to
-- times converted to UTC by localHHMMToUtcHHMM(), while
-- lib/appointments.ts::assertWithinAvailability() read the UTC weekday and UTC
-- time. The two agree only when the conversion does not cross midnight.
--
-- BACKFILL CORRECTNESS. Existing rows hold: weekday = LOCAL weekday (never
-- converted), start/end = UTC time-of-day. So recovering local time is
-- `utc + offset`, and the weekday is already correct and must NOT move.
--
-- The offset is taken at 2026-01-01 rather than at the column's stored epoch.
-- These are `time` columns; combining them with 1970-01-01 would apply 1970's
-- offset, and Tbilisi was UTC+3 then and is UTC+4 now — the backfill would be
-- an hour out for every existing row. The application has the same rule
-- (lib/tz.ts uses a current reference date, not 1970).
--
-- Production today holds five Asia/Tbilisi windows stored as 04:00-19:00 UTC;
-- this restores them to 08:00-23:00 local, which is what was typed.
--
-- ROLLBACK:
--   UPDATE staff_availability sa
--      SET start_time = ((DATE '2026-01-01' + sa.start_time) AT TIME ZONE l.timezone
--                          AT TIME ZONE 'UTC')::time,
--          end_time   = ((DATE '2026-01-01' + sa.end_time)   AT TIME ZONE l.timezone
--                          AT TIME ZONE 'UTC')::time
--     FROM staff s JOIN locations l ON l.id = s.location_id
--    WHERE sa.staff_id = s.id;
--   ALTER TABLE staff DROP COLUMN availability_configured_at;
-- Expand-only: the column is nullable and the rewrite is value-preserving, so
-- the pre-migration build keeps working against the post-migration schema for
-- as long as it takes to roll forward.

ALTER TABLE "staff"
  ADD COLUMN IF NOT EXISTS "availability_configured_at" TIMESTAMPTZ(6);

UPDATE "staff_availability" sa
   SET "start_time" = ((DATE '2026-01-01' + sa."start_time") AT TIME ZONE 'UTC'
                         AT TIME ZONE l."timezone")::time,
       "end_time"   = ((DATE '2026-01-01' + sa."end_time")   AT TIME ZONE 'UTC'
                         AT TIME ZONE l."timezone")::time
  FROM "staff" s
  JOIN "locations" l ON l."id" = s."location_id"
 WHERE sa."staff_id" = s."id"
   AND l."timezone" IS NOT NULL;

-- Any staff member who already has windows was configured by somebody, so the
-- day-off semantics below must apply to them. Staff with no rows keep NULL and
-- keep the legacy fall-through.
UPDATE "staff" s
   SET "availability_configured_at" = NOW()
 WHERE EXISTS (SELECT 1 FROM "staff_availability" sa WHERE sa."staff_id" = s."id");
