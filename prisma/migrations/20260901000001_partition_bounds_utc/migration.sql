-- Partition bounds no longer depend on the session time zone.
--
-- bp_create_monthly_partition() computed its boundaries as:
--
--     start_ts := date_trunc('month', month::timestamptz);
--
-- `date::timestamptz` resolves the date at midnight IN THE SESSION TIME ZONE.
-- Called from a UTC session — Vercel, a GitHub runner, the migrate workflow —
-- that yields 2026-09-01T00:00:00Z and everything is correct. Called from a
-- session on any other zone it does not. Measured on a developer machine whose
-- PostgreSQL defaults to Asia/Tbilisi (+04):
--
--     audit_log_2026_09  FOR VALUES FROM ('2026-08-31 20:00:00+00')
--                                     TO ('2026-09-30 20:00:00+00')
--
-- Every month is shifted four hours early. Audit rows written between 20:00Z
-- and 23:59Z on the last day of a month land in the NEXT month's partition,
-- and the same at every other boundary.
--
-- Why this went unnoticed: the misrouted rows land in a neighbouring
-- partition, not in audit_log_default. The production invariant of the day
-- asserted only "at least one partition exists" and "audit_log_default is
-- empty", and both remain true while the boundaries are wrong. `to_char` on a
-- timestamptz renders in the session zone too, so the partition NAME agreed
-- with the misplaced bounds and nothing looked inconsistent.
--
-- The fix does the month arithmetic on a zone-free `timestamp` and attaches
-- UTC once, at the end. The result is identical for a UTC caller — production
-- partitions are already on exact UTC boundaries and are not touched — and
-- correct for every other caller.
--
-- CREATE OR REPLACE only. No partition is created, altered or dropped here;
-- existing partitions keep the bounds they were created with, and
-- scripts/verify-production-invariants.sql check 6 now fails loudly on any
-- that are not UTC-aligned rather than reporting them as healthy.
--
-- ROLLBACK
--   Re-run the previous definition, which is preserved verbatim in
--   prisma/migrations/20260727170000_rbac_audit_log_append_only/migration.sql.
--   Doing so restores the session-time-zone dependency; the only reason to is
--   if some caller is relying on local-midnight boundaries, and none is.

CREATE OR REPLACE FUNCTION public.bp_create_monthly_partition(parent regclass, month date)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
    part_name text;
    month_start timestamp;   -- deliberately zone-free
    start_ts  timestamptz;
    end_ts    timestamptz;
BEGIN
    -- Truncate while the value still has no time zone, so the month boundary
    -- is a calendar fact rather than a function of the caller's session.
    month_start := date_trunc('month', month::timestamp);
    start_ts := month_start AT TIME ZONE 'UTC';
    end_ts   := (month_start + INTERVAL '1 month') AT TIME ZONE 'UTC';
    -- Named from the zone-free value for the same reason: to_char() on a
    -- timestamptz would render in the session zone and could disagree with
    -- the bounds by a month at the boundary.
    part_name := parent::text || '_' || to_char(month_start, 'YYYY_MM');
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        part_name, parent, start_ts, end_ts
    );
    -- Append-only invariant: revoke mutation grants that the schema-wide
    -- default would otherwise hand to bookpitch_app.
    IF parent::text = 'audit_log' THEN
        EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM bookpitch_app', part_name);
    END IF;
END;
$function$;
