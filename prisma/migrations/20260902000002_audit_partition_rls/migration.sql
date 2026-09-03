-- Row-level security does not inherit downwards. Close the bypass.
--
-- audit_log is a partitioned parent with RLS enabled, FORCED, and a
-- tenant_isolation policy. Every check in this repository verified the PARENT:
-- the production invariant script, tests/rbac-rls.test.ts, the restore drill.
-- None asked what happens when a child is addressed by name.
--
-- In PostgreSQL a partition does NOT inherit the parent's row security when it
-- is named directly — the child's own relrowsecurity decides — and the
-- migrations never set it. tests/rbac-rls.test.ts even EXEMPTS these tables
-- with the comment "the parent enforces RLS; partitions inherit", which is
-- precisely the assumption that is false.
--
-- Measured on the development database 2026-09-02, as bookpitch_app
-- (NOSUPERUSER NOBYPASSRLS) with no organization context:
--
--   SELECT count(*) FROM audit_log            WHERE organization_id IS NOT NULL  ->     0
--   SELECT count(*) FROM audit_log_2026_09    WHERE organization_id IS NOT NULL  ->  1705
--   SELECT count(DISTINCT organization_id) FROM audit_log_2026_09                ->    15
--
-- Every audit record of every organization, readable by naming a partition.
-- The same path allowed INSERT, i.e. forging an audit record attributed to
-- another tenant, which the append-only triggers do not prevent because they
-- only block UPDATE, DELETE and TRUNCATE.
--
-- THE FIX, in two independent layers.
--
--   1. Revoke every privilege on the partitions from bookpitch_app. The
--      application never addresses a partition by name; it always goes through
--      audit_log. PostgreSQL checks privileges on the relation named in the
--      query, so revoking on children costs nothing:
--
--        direct child SELECT   -> permission denied
--        parent SELECT         -> unchanged
--        parent INSERT         -> unchanged (routing to a revoked child works)
--
--      Verified experimentally before writing this migration.
--
--   2. Enable and FORCE row security on each partition anyway, with the same
--      tenant_isolation predicate the parent carries. Belt and braces: if a
--      future GRANT reappears — a default privilege, a hand-run grant, a
--      restore from an older dump — the rows are still filtered rather than
--      exposed. Layer 1 alone would fail open in that case.
--
-- Forward-only and idempotent. Applies to every existing partition including
-- audit_log_default, and bp_create_monthly_partition() is replaced below so
-- future partitions are safe on creation rather than needing another migration.
--
-- ROLLBACK
--   See down.sql. Rolling this back restores the cross-tenant read, so do it
--   only to diagnose a routing problem, and re-apply immediately afterwards.

DO $$
DECLARE
  part record;
BEGIN
  FOR part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_namespace n ON n.oid = p.relnamespace
     WHERE n.nspname = 'public' AND p.relname = 'audit_log'
  LOOP
    -- Layer 1: the application role has no business naming a partition.
    EXECUTE format('REVOKE ALL ON public.%I FROM bookpitch_app', part.relname);

    -- Layer 2: filter anyway, in case a grant ever comes back.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', part.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', part.relname);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', part.relname);
    -- Same predicate as the parent: organization_id IS NULL is the
    -- platform-plane audit row that every tenant may see.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL '
      'USING (organization_id = current_org_id() OR organization_id IS NULL) '
      'WITH CHECK (organization_id = current_org_id() OR organization_id IS NULL)',
      part.relname);
  END LOOP;
END $$;

-- Future partitions are protected at creation. Without this the monthly cron
-- would reintroduce the hole every month, and the repair above would be a
-- one-off that silently decays.
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
    part_name := parent::text || '_' || to_char(month_start, 'YYYY_MM');
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        part_name, parent, start_ts, end_ts
    );

    IF parent::text = 'audit_log' THEN
        -- Append-only: the schema-wide default would hand these to
        -- bookpitch_app otherwise.
        EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM bookpitch_app', part_name);
        -- And the partition-bypass fix: no direct access at all, plus row
        -- security in its own right so a future grant cannot expose it.
        EXECUTE format('REVOKE ALL ON %I FROM bookpitch_app', part_name);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part_name);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', part_name);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I FOR ALL '
          'USING (organization_id = current_org_id() OR organization_id IS NULL) '
          'WITH CHECK (organization_id = current_org_id() OR organization_id IS NULL)',
          part_name);
    END IF;
END;
$function$;
