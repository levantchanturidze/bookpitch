-- Rollback for 20260902000002_audit_partition_rls.
--
-- WARNING: this restores a cross-tenant read. With these grants back and row
-- security off, bookpitch_app can read every organization's audit records by
-- naming a partition directly. Roll back only to diagnose a routing problem,
-- and re-apply immediately.
DO $$
DECLARE
  part record;
BEGIN
  FOR part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE p.relname = 'audit_log'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', part.relname);
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', part.relname);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', part.relname);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO bookpitch_app', part.relname);
  END LOOP;
END $$;
