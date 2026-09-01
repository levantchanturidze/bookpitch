-- Rollback for 20260901000001_partition_bounds_utc.
--
-- Restores the session-time-zone-dependent definition exactly as it stood in
-- 20260727170000_rbac_audit_log_append_only. Creating partitions from a non-UTC
-- session after running this will again produce bounds offset by that session's
-- UTC offset, which scripts/verify-production-invariants.sql check 6 rejects.

CREATE OR REPLACE FUNCTION public.bp_create_monthly_partition(parent regclass, month date)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
    part_name text;
    start_ts  timestamptz;
    end_ts    timestamptz;
BEGIN
    start_ts := date_trunc('month', month::timestamptz);
    end_ts   := start_ts + INTERVAL '1 month';
    part_name := parent::text || '_' || to_char(start_ts, 'YYYY_MM');
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        part_name, parent, start_ts, end_ts
    );
    IF parent::text = 'audit_log' THEN
        EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM bookpitch_app', part_name);
    END IF;
END;
$function$;
