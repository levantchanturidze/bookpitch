-- STAGE D preflight: read-only inventory of what the backfill is about to touch.
--
-- Runs BEFORE the migration applies, in the same workflow run, so the log holds
-- the live state the conversion was decided against rather than a historical
-- lead. Changes nothing.
--
-- Prints counts and wall-clock values only. Availability times are not personal
-- data; staff identifiers are truncated anyway so the log carries no joinable
-- identifier.
\set ON_ERROR_STOP on

\echo '=== availability inventory, by basis ==='
SELECT
  sa.time_basis,
  count(*)                        AS rows,
  count(DISTINCT sa.staff_id)     AS staff,
  count(DISTINCT l.timezone)      AS timezones,
  min(sa.start_time)::text        AS earliest_start,
  max(sa.end_time)::text          AS latest_end
FROM staff_availability sa
JOIN staff s   ON s.id = sa.staff_id
JOIN locations l ON l.id = s.location_id
GROUP BY sa.time_basis
ORDER BY sa.time_basis;

\echo '=== every timezone actually present (the conversion must support each) ==='
SELECT l.timezone,
       count(*) FILTER (WHERE sa.time_basis = 'utc_legacy') AS legacy_rows,
       count(*) FILTER (WHERE sa.time_basis = 'local')      AS local_rows,
       -- Does PostgreSQL recognise it? An unknown zone must abort, not guess.
       EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = l.timezone) AS tz_known
FROM staff_availability sa
JOIN staff s   ON s.id = sa.staff_id
JOIN locations l ON l.id = s.location_id
GROUP BY l.timezone
ORDER BY l.timezone;

\echo '=== legacy rows in detail: before -> after, per weekday ==='
-- The conversion converts the TIME only. `weekday` is already LOCAL in legacy
-- rows — the editor wrote the local weekday beside a UTC time, which is exactly
-- the inconsistency that caused this whole rollout — so it must NOT be shifted.
SELECT
  left(sa.staff_id::text, 8) || '…'                         AS staff,
  l.timezone,
  sa.weekday,
  sa.start_time::text                                       AS before_start,
  sa.end_time::text                                         AS before_end,
  ((DATE '2026-01-01' + sa.start_time) AT TIME ZONE 'UTC'
     AT TIME ZONE l.timezone)::time::text                   AS after_start,
  ((DATE '2026-01-01' + sa.end_time) AT TIME ZONE 'UTC'
     AT TIME ZONE l.timezone)::time::text                   AS after_end,
  -- The failure mode worth seeing before it happens: a window whose UTC form
  -- straddles local midnight inverts, because only the time is shifted.
  (((DATE '2026-01-01' + sa.end_time) AT TIME ZONE 'UTC' AT TIME ZONE l.timezone)::time
     <= ((DATE '2026-01-01' + sa.start_time) AT TIME ZONE 'UTC' AT TIME ZONE l.timezone)::time)
                                                            AS would_invert
FROM staff_availability sa
JOIN staff s   ON s.id = sa.staff_id
JOIN locations l ON l.id = s.location_id
WHERE sa.time_basis = 'utc_legacy'
ORDER BY l.timezone, sa.weekday, sa.start_time;

\echo '=== preflight verdict ==='
SELECT
  count(*) FILTER (WHERE sa.time_basis = 'utc_legacy')                       AS to_convert,
  count(*) FILTER (WHERE sa.time_basis = 'local')                            AS already_local,
  count(*) FILTER (
    WHERE sa.time_basis = 'utc_legacy'
      AND NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = l.timezone)
  )                                                                          AS unknown_timezone,
  count(*) FILTER (
    WHERE sa.time_basis = 'utc_legacy'
      AND ((DATE '2026-01-01' + sa.end_time) AT TIME ZONE 'UTC' AT TIME ZONE l.timezone)::time
          <= ((DATE '2026-01-01' + sa.start_time) AT TIME ZONE 'UTC' AT TIME ZONE l.timezone)::time
  )                                                                          AS would_invert
FROM staff_availability sa
JOIN staff s   ON s.id = sa.staff_id
JOIN locations l ON l.id = s.location_id;
