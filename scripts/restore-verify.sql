-- Post-restore invariant checks for the restore drill.
--
-- Run with `psql -v ON_ERROR_STOP=1 -f scripts/restore-verify.sql`. Every check
-- RAISEs on failure, so the script's exit code is the drill's verdict — there
-- is no way for a failed assertion to be read as a pass.
--
-- Nothing here selects a customer, an email address, a name, a phone number or
-- an audit payload. Only counts, catalog metadata and structural predicates.

\echo '=== restore verification: starting ==='

-- 1. Prisma migration history survived the round trip. -----------------------
DO $$
DECLARE
  applied integer;
  unfinished integer;
BEGIN
  IF to_regclass('public._prisma_migrations') IS NULL THEN
    RAISE EXCEPTION 'restore-verify: _prisma_migrations table is missing';
  END IF;

  SELECT count(*) INTO applied FROM public._prisma_migrations;
  IF applied < 60 THEN
    RAISE EXCEPTION 'restore-verify: only % migrations restored, expected at least 60', applied;
  END IF;

  SELECT count(*) INTO unfinished
    FROM public._prisma_migrations
   WHERE finished_at IS NULL AND rolled_back_at IS NULL;
  IF unfinished > 0 THEN
    RAISE EXCEPTION 'restore-verify: % migrations are neither finished nor rolled back', unfinished;
  END IF;

  RAISE NOTICE 'ok: % prisma migrations, all finished', applied;
END $$;

-- 2. Required application tables exist. --------------------------------------
DO $$
DECLARE
  required text[] := ARRAY[
    'organizations', 'app_users', 'memberships', 'membership_branches',
    'roles', 'permissions', 'role_permissions', 'role_can_manage',
    'branches', 'locations', 'services', 'staff', 'staff_availability',
    'customers', 'appointments', 'treatment_history', 'payments',
    'invitations', 'ownership_transfers', 'pending_registrations',
    'verification_tokens', 'audit_log', 'email_outbox',
    'break_glass_sessions', 'impersonation_sessions',
    'app_user_recovery_codes', 'platform_reauth_grant', 'platform_rate_limit'
  ];
  missing text[] := '{}';
  t text;
BEGIN
  FOREACH t IN ARRAY required LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NULL THEN
      missing := missing || t;
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'restore-verify: missing tables: %', array_to_string(missing, ', ');
  END IF;
  RAISE NOTICE 'ok: all % required tables present', array_length(required, 1);
END $$;

-- 3. Tenant tables contain structurally valid rows. --------------------------
--    Counts and NULL/orphan predicates only; no row contents are read.
DO $$
DECLARE
  orgs integer;
  bad integer;
BEGIN
  SELECT count(*) INTO orgs FROM public.organizations;
  IF orgs < 1 THEN
    RAISE EXCEPTION 'restore-verify: organizations table restored empty';
  END IF;

  SELECT count(*) INTO bad FROM public.organizations WHERE id IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'restore-verify: % organizations with NULL id', bad; END IF;

  -- Every membership must be tenant-scoped and point at a real org+user.
  SELECT count(*) INTO bad FROM public.memberships WHERE organization_id IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'restore-verify: % memberships with NULL organization_id', bad; END IF;

  SELECT count(*) INTO bad
    FROM public.memberships m
    LEFT JOIN public.organizations o ON o.id = m.organization_id
   WHERE o.id IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'restore-verify: % orphaned memberships (no organization)', bad; END IF;

  SELECT count(*) INTO bad
    FROM public.memberships m
    LEFT JOIN public.app_users u ON u.id = m.user_id
   WHERE u.id IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'restore-verify: % orphaned memberships (no user)', bad; END IF;

  RAISE NOTICE 'ok: % organizations, memberships structurally valid', orgs;
END $$;

-- 4. Append-only audit log protections survived. ------------------------------
DO $$
DECLARE
  required text[] := ARRAY['audit_log_no_update', 'audit_log_no_delete', 'audit_log_no_truncate'];
  missing text[] := '{}';
  t text;
  rows_restored integer;
BEGIN
  FOREACH t IN ARRAY required LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger tg
        JOIN pg_class c ON c.oid = tg.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'audit_log'
         AND tg.tgname = t AND NOT tg.tgisinternal
    ) THEN
      missing := missing || t;
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'restore-verify: audit_log is missing protection triggers: %',
      array_to_string(missing, ', ');
  END IF;

  SELECT count(*) INTO rows_restored FROM public.audit_log;
  RAISE NOTICE 'ok: audit_log append-only triggers present, % rows restored', rows_restored;
END $$;

-- 4b. The protections are not decorative: prove UPDATE actually fails. --------
--     This is the complement assertion. Without it we would only be checking
--     that a catalog row exists, which is wiring, not behaviour.
DO $$
DECLARE
  blocked boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM public.audit_log) THEN
    BEGIN
      UPDATE public.audit_log SET action = action WHERE true;
      blocked := false;
    EXCEPTION WHEN OTHERS THEN
      blocked := true;
    END;
    IF NOT blocked THEN
      RAISE EXCEPTION 'restore-verify: audit_log accepted an UPDATE — append-only guarantee did NOT survive the restore';
    END IF;
    RAISE NOTICE 'ok: audit_log UPDATE is rejected by the restored trigger';
  ELSE
    RAISE NOTICE 'skip: audit_log has no rows to attempt an UPDATE against';
  END IF;
END $$;

-- 5. Audit log is still partitioned. ------------------------------------------
DO $$
DECLARE
  parts integer;
BEGIN
  SELECT count(*) INTO parts
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
   WHERE n.nspname = 'public' AND p.relname = 'audit_log';
  IF parts < 2 THEN
    RAISE EXCEPTION 'restore-verify: audit_log has % partitions, expected the monthly partition set', parts;
  END IF;
  RAISE NOTICE 'ok: audit_log has % partitions', parts;
END $$;

-- 6. RLS policies exist and RLS is enabled on tenant tables. ------------------
DO $$
DECLARE
  policies integer;
  unprotected text[];
BEGIN
  SELECT count(*) INTO policies FROM pg_policies WHERE schemaname = 'public';
  IF policies < 15 THEN
    RAISE EXCEPTION 'restore-verify: only % RLS policies restored, expected at least 15', policies;
  END IF;

  SELECT array_agg(c.relname ORDER BY c.relname) INTO unprotected
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND c.relname IN ('organizations', 'customers', 'appointments', 'memberships', 'audit_log')
     AND NOT c.relrowsecurity;
  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'restore-verify: row level security is disabled on: %',
      array_to_string(unprotected, ', ');
  END IF;

  RAISE NOTICE 'ok: % RLS policies, RLS enabled on tenant tables', policies;
END $$;

-- 7. Owner invariant triggers and functions survived. -------------------------
DO $$
DECLARE
  missing text[] := '{}';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
     WHERE c.relname = 'memberships' AND tg.tgname = 'enforce_org_owner_on_membership'
       AND NOT tg.tgisinternal
  ) THEN missing := missing || 'trigger enforce_org_owner_on_membership'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
     WHERE c.relname = 'organizations' AND tg.tgname = 'enforce_org_owner_on_org'
       AND NOT tg.tgisinternal
  ) THEN missing := missing || 'trigger enforce_org_owner_on_org'; END IF;

  IF to_regprocedure('public.check_org_owner_invariant()') IS NULL
     AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = 'check_org_owner_invariant')
  THEN missing := missing || 'function check_org_owner_invariant'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'check_org_owner_from_membership')
  THEN missing := missing || 'function check_org_owner_from_membership'; END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'restore-verify: owner invariant objects missing: %',
      array_to_string(missing, ', ');
  END IF;
  RAISE NOTICE 'ok: owner invariant triggers and functions present';
END $$;

-- 8. Durable email outbox schema survived, with the columns the worker needs. --
DO $$
DECLARE
  required text[] := ARRAY['id', 'status', 'attempts', 'created_at'];
  missing text[] := '{}';
  col text;
BEGIN
  IF to_regclass('public.email_outbox') IS NULL THEN
    RAISE EXCEPTION 'restore-verify: email_outbox table is missing';
  END IF;
  FOREACH col IN ARRAY required LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'email_outbox' AND column_name = col
    ) THEN missing := missing || col; END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'restore-verify: email_outbox missing columns: %', array_to_string(missing, ', ');
  END IF;
  RAISE NOTICE 'ok: email_outbox schema present';
END $$;

-- 9. Partition maintenance function survived (cron/db-partitions depends on it).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'bp_create_monthly_partition'
  ) THEN
    RAISE EXCEPTION 'restore-verify: bp_create_monthly_partition() is missing';
  END IF;
  RAISE NOTICE 'ok: bp_create_monthly_partition() present';
END $$;

\echo '=== restore verification: ALL CHECKS PASSED ==='
