-- ---------------------------------------------------------------------------
-- Read-only production invariants, run after every migration deploy.
--
-- `prisma migrate status` proves the migration ledger. It says nothing about
-- whether the security posture the migrations built is still standing, and a
-- restore is exactly the event that can silently lose it: roles are globals and
-- do not travel inside a `pg_dump` of one database, RLS policies can come back
-- without FORCE, and a permission row deleted by a migration can reappear from
-- an older dump. On 2026-09-01 production was restored from a 2026-08-22 backup
-- and none of that was verifiable from outside.
--
-- Everything here is a SELECT. The session is pinned read-only on the first
-- line, so the script cannot write even if someone later adds a statement that
-- tries to — deliberately unlike scripts/restore-verify.sql, which proves
-- append-only by ATTEMPTING an UPDATE and must therefore never be aimed at
-- production.
--
-- Raises an exception on the first violated invariant, so the workflow step
-- fails loudly rather than printing a wall of NOTICEs nobody reads.
--
-- RUN IT WITH `psql -f`, NEVER `psql -c`. The read-only pin below sets the
-- default for *subsequent* transactions; `-c "SET …; DELETE …"` puts both in
-- one implicit transaction, so the pin does not apply to the statement it was
-- meant to stop and the guard is silently disarmed. Measured both ways:
--
--   psql -f  → ERROR: cannot execute DELETE in a read-only transaction
--   psql -c  → DELETE 0
--
-- tests/workflow-safety.test.ts asserts the workflow invokes it with -f.
-- ---------------------------------------------------------------------------

SET default_transaction_read_only = on;

\set ON_ERROR_STOP on

-- 1. Migration ledger: every migration finished, none rolled back. -----------
DO $$
DECLARE
  applied int;
  unfinished int;
  rolled int;
BEGIN
  SELECT count(*) INTO applied FROM public._prisma_migrations WHERE finished_at IS NOT NULL;
  SELECT count(*) INTO unfinished FROM public._prisma_migrations
    WHERE finished_at IS NULL AND rolled_back_at IS NULL;
  SELECT count(*) INTO rolled FROM public._prisma_migrations WHERE rolled_back_at IS NOT NULL;

  IF unfinished > 0 THEN
    RAISE EXCEPTION 'production-verify: % migration(s) neither finished nor rolled back', unfinished;
  END IF;
  IF rolled > 0 THEN
    RAISE EXCEPTION 'production-verify: % migration(s) rolled back', rolled;
  END IF;

  RAISE NOTICE 'ok: % migrations applied, 0 unfinished, 0 rolled back', applied;
END $$;

-- 2. The runtime role is still the constrained one. --------------------------
--
-- Roles are cluster globals. A restore into a fresh project recreates the
-- database and not necessarily the role, and a role recreated by hand is
-- exactly where SUPERUSER or BYPASSRLS creeps back in. CLAUDE.md invariant 1
-- depends on this being false, twice.
DO $$
DECLARE
  is_super bool;
  is_bypass bool;
  can_login bool;
BEGIN
  SELECT rolsuper, rolbypassrls, rolcanlogin INTO is_super, is_bypass, can_login
    FROM pg_roles WHERE rolname = 'bookpitch_app';

  IF is_super IS NULL THEN
    RAISE EXCEPTION 'production-verify: role bookpitch_app does not exist — the application cannot be running as a constrained role';
  END IF;
  IF is_super THEN
    RAISE EXCEPTION 'production-verify: bookpitch_app is SUPERUSER — row-level security is bypassed for every tenant query';
  END IF;
  IF is_bypass THEN
    RAISE EXCEPTION 'production-verify: bookpitch_app has BYPASSRLS — row-level security is bypassed for every tenant query';
  END IF;
  IF NOT can_login THEN
    RAISE EXCEPTION 'production-verify: bookpitch_app cannot log in';
  END IF;

  RAISE NOTICE 'ok: bookpitch_app is NOSUPERUSER NOBYPASSRLS and can log in';
END $$;

-- 3. The audit log is append-only, enforced by privilege not by code. --------
DO $$
DECLARE
  can_update bool;
  can_delete bool;
BEGIN
  SELECT has_table_privilege('bookpitch_app', 'public.audit_log', 'UPDATE'),
         has_table_privilege('bookpitch_app', 'public.audit_log', 'DELETE')
    INTO can_update, can_delete;

  IF can_update THEN
    RAISE EXCEPTION 'production-verify: bookpitch_app has UPDATE on audit_log — the append-only guarantee is gone';
  END IF;
  IF can_delete THEN
    RAISE EXCEPTION 'production-verify: bookpitch_app has DELETE on audit_log — the append-only guarantee is gone';
  END IF;

  RAISE NOTICE 'ok: bookpitch_app has neither UPDATE nor DELETE on audit_log';
END $$;

-- 4. RLS is enabled AND forced on every tenant table. ------------------------
--
-- ENABLE without FORCE is the quiet failure: the table owner keeps bypassing
-- its own policies, so a query that runs as the owner returns every tenant's
-- rows while `relrowsecurity` reads true.
DO $$
DECLARE
  enabled int;
  forced int;
  missing text;
BEGIN
  SELECT count(*) FILTER (WHERE c.relrowsecurity),
         count(*) FILTER (WHERE c.relforcerowsecurity)
    INTO enabled, forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r';

  IF enabled = 0 THEN
    RAISE EXCEPTION 'production-verify: no table in public has row-level security enabled';
  END IF;
  IF forced <> enabled THEN
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relrowsecurity AND NOT c.relforcerowsecurity;
    RAISE EXCEPTION 'production-verify: % table(s) have RLS enabled but not FORCED (%) — the owner bypasses its own policies', enabled - forced, missing;
  END IF;

  RAISE NOTICE 'ok: % tables with RLS, all % FORCED', enabled, forced;
END $$;

-- 5. F16-012: MARKETING holds no route to patient contact details. ----------
--
-- Migration 20260823000001 deletes the grant. A restore from a dump taken
-- before that migration brings it back, and nothing else in production would
-- report it: lib/rbac/role-denials.ts refuses the permission above the granted
-- set, so the application keeps behaving correctly while the database quietly
-- disagrees with the seed. That is the state this check exists to catch.
DO $$
DECLARE
  leaked int;
  reporting int;
BEGIN
  SELECT count(*) INTO leaked
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
   WHERE r.key = 'MARKETING'
     AND r.organization_id IS NULL
     AND rp.permission_key = 'client.read:contact';

  IF leaked > 0 THEN
    RAISE EXCEPTION 'production-verify: the system MARKETING role still grants client.read:contact — migration 20260823000001 is not reflected in this database';
  END IF;

  -- Complement. Without it, a MARKETING role that lost every permission — or a
  -- roles table that came back empty — would satisfy the check above.
  SELECT count(*) INTO reporting
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
   WHERE r.key = 'MARKETING'
     AND r.organization_id IS NULL
     AND rp.permission_key IN ('report.own', 'report.branch');

  IF reporting <> 2 THEN
    RAISE EXCEPTION 'production-verify: MARKETING holds % of its 2 reporting grants — the bundle is not intact, so the revocation check above proves nothing', reporting;
  END IF;

  RAISE NOTICE 'ok: MARKETING has no client.read:contact and keeps both reporting grants';
END $$;

-- 6. audit_log partitioning is still ahead of today. ------------------------
DO $$
DECLARE
  parts int;
  default_rows bigint;
BEGIN
  SELECT count(*) INTO parts
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
   WHERE p.relname = 'audit_log';

  IF parts = 0 THEN
    RAISE EXCEPTION 'production-verify: audit_log has no partitions';
  END IF;

  EXECUTE 'SELECT count(*) FROM public.audit_log_default' INTO default_rows;
  IF default_rows > 0 THEN
    RAISE EXCEPTION 'production-verify: % row(s) landed in audit_log_default — a month is missing its partition', default_rows;
  END IF;

  RAISE NOTICE 'ok: audit_log has % partitions and audit_log_default is empty', parts;
END $$;

\echo '=== production invariants: ALL CHECKS PASSED ==='
