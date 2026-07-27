-- Rollback for 20260727170000_rbac_audit_log_append_only.
-- Restores the pre-Phase-1 state: mutation grants back on bookpitch_app,
-- triggers dropped, partition helper reverted, spec §7.1 columns dropped.

-- Re-grant on the parent + every partition.
GRANT UPDATE, DELETE ON "audit_log" TO bookpitch_app;
DO $$
DECLARE p_name text;
BEGIN
    FOR p_name IN
        SELECT c.relname
          FROM pg_inherits i
          JOIN pg_class    c ON c.oid = i.inhrelid
          JOIN pg_class    p ON p.oid = i.inhparent
          JOIN pg_namespace n ON n.oid = p.relnamespace
         WHERE p.relname = 'audit_log' AND n.nspname = 'public'
    LOOP
        EXECUTE format('GRANT UPDATE, DELETE ON %I TO bookpitch_app', p_name);
    END LOOP;
END $$;

DROP TRIGGER  IF EXISTS audit_log_no_update ON "audit_log";
DROP TRIGGER  IF EXISTS audit_log_no_delete ON "audit_log";
DROP FUNCTION IF EXISTS audit_log_block_mutation();

-- Restore the original bp_create_monthly_partition() (no post-create REVOKE).
CREATE OR REPLACE FUNCTION bp_create_monthly_partition(parent regclass, month date)
RETURNS void AS $$
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
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "audit_log"
    DROP CONSTRAINT IF EXISTS "audit_log_on_behalf_of_user_id_fkey",
    DROP COLUMN IF EXISTS "break_glass_session_id",
    DROP COLUMN IF EXISTS "impersonation_session_id",
    DROP COLUMN IF EXISTS "reason",
    DROP COLUMN IF EXISTS "user_agent",
    DROP COLUMN IF EXISTS "on_behalf_of_user_id";
