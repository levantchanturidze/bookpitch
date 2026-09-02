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
-- Deterministic timestamp rendering: the partition bounds in check 6 are
-- parsed back out of pg_get_expr(), whose output is formatted in the session
-- time zone. Pinning UTC keeps the comparison stable wherever this is run.
SET TimeZone = 'UTC';

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

-- 4. RLS is enabled AND forced on every tenant relation, with a real policy. --
--
-- ENABLE without FORCE is the quiet failure: the table owner keeps bypassing
-- its own policies, so a query that runs as the owner returns every tenant's
-- rows while `relrowsecurity` reads true.
--
-- The previous version of this check counted relations that already had
-- `relrowsecurity = true` and asserted the FORCE count matched. Two ways that
-- passes while production is unsafe, both measured on 2026-09-01:
--
--   1. A required tenant table that loses BOTH bits disappears from both
--      counts. `enabled` and `forced` stay equal and the check reports ok.
--      Losing RLS entirely was invisible; only losing FORCE was caught.
--   2. It filtered `relkind = 'r'`, so `audit_log` — which is `relkind = 'p'`,
--      a partitioned parent, and holds every audit record for every tenant —
--      was never examined at all. Production reported "20 tables with RLS, all
--      20 FORCED" while the 21st, the audit log, went unchecked.
--
-- So the expected set is now stated explicitly rather than derived from the
-- state being audited. A check whose expectations come from the thing it is
-- checking cannot fail. Three sets, and all three are asserted:
--
--   REQUIRED   must exist, RLS enabled, FORCE enabled, tenant_isolation policy
--   EXEMPT     has organization_id but is deliberately RLS-free, with reasons
--   partitions audit_log_YYYY_MM / audit_log_default — RLS lives on the parent
--
-- Anything carrying organization_id that is in neither list fails: that is a
-- new tenant table added without RLS, which is the leak this exists to catch.
--
-- Mirrors tests/rbac-rls.test.ts, which derives the same set from the
-- organization_id column and applies the same exemptions.
DO $$
DECLARE
  -- Every relation that must be RLS-protected. 17 carry organization_id
  -- directly; organizations keys on id, and membership_branches,
  -- staff_availability and treatment_history isolate through a join to a
  -- parent that does. All 21 are listed because they are all tenant data.
  required_rels CONSTANT text[] := ARRAY[
    'appointments', 'assistant_usage', 'audit_log', 'branches', 'customers',
    'invitations', 'locations', 'membership_branches', 'memberships',
    'message_log', 'message_templates', 'notifications', 'organizations',
    'ownership_transfers', 'payments', 'rate_limit', 'services', 'staff',
    'staff_availability', 'treatment_history', 'waitlist'
  ];
  -- Carries organization_id, deliberately not RLS-protected:
  --   roles                    reference data; custom-role isolation is
  --                            enforced at query time (rbac-schema-notes §3.2)
  --   impersonation_sessions   platform-plane bookkeeping, read only by
  --                            lib/rbac/context.ts via unsafePrismaAdmin
  exempt_rels CONSTANT text[] := ARRAY['roles', 'impersonation_sessions'];
  missing text;
  unprotected text;
  rec record;
  n_permissive int;
  n_policies int;
  pol_name text;
  pol_cmd text;
  pol_permissive bool;
  pol_qual text;
  pol_check text;
  pol_roles text;
  unclassified text;
  exempt_drift text;
  n_required int;
BEGIN
  -- 4a. Every required relation exists. A dropped table must not pass by
  --     silently leaving the population being counted.
  SELECT string_agg(want, ', ' ORDER BY want) INTO missing
    FROM unnest(required_rels) AS want
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = want AND c.relkind IN ('r', 'p')
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'production-verify: required tenant relation(s) absent: % — the schema does not match the expected tenant set', missing;
  END IF;

  -- 4b. Each one has RLS enabled AND forced. Both bits, named separately, so
  --     the failure message says which half is gone.
  SELECT string_agg(
           c.relname || ' (' ||
           CASE WHEN NOT c.relrowsecurity AND NOT c.relforcerowsecurity THEN 'RLS DISABLED and not forced'
                WHEN NOT c.relrowsecurity THEN 'RLS DISABLED'
                ELSE 'not FORCED' END || ')', ', ' ORDER BY c.relname)
    INTO unprotected
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = ANY(required_rels)
     AND c.relkind IN ('r', 'p')
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'production-verify: tenant relation(s) without enforced RLS: % — tenant rows are readable across organizations', unprotected;
  END IF;

  -- 4c. Each one carries EXACTLY the policy it is supposed to, and no other.
  --
  -- The previous version asked whether the policy text CONTAINED
  -- `current_org_id()`. That is not a security property. All of these contain
  -- it and none of them isolate anything:
  --
  --     USING (organization_id = current_org_id() OR true)
  --     USING (current_org_id() IS NOT NULL)
  --     USING (true) -- plus a second policy mentioning current_org_id()
  --
  -- Postgres ORs permissive policies together, so ONE extra permissive policy
  -- on a table defeats every other policy on it. Substring matching cannot see
  -- that, and neither could the old check.
  --
  -- So the expected expression is stated exactly, per relation, and anything
  -- else fails — including an additional policy that looks harmless. A
  -- deliberate policy change must update this table, which is the point: the
  -- expectation lives outside the thing being audited.
  FOR rec IN
    SELECT * FROM (VALUES
      ('appointments',        '(organization_id = current_org_id())'),
      ('assistant_usage',     '(organization_id = current_org_id())'),
      ('audit_log',           '((organization_id = current_org_id()) OR (organization_id IS NULL))'),
      ('branches',            '(organization_id = current_org_id())'),
      ('customers',           '(organization_id = current_org_id())'),
      ('invitations',         '(organization_id = current_org_id())'),
      ('locations',           '(organization_id = current_org_id())'),
      ('membership_branches', '(branch_id IN ( SELECT branches.id FROM branches WHERE (branches.organization_id = current_org_id())))'),
      ('memberships',         '(organization_id = current_org_id())'),
      ('message_log',         '(organization_id = current_org_id())'),
      ('message_templates',   '(organization_id = current_org_id())'),
      ('notifications',       '(organization_id = current_org_id())'),
      ('organizations',       '(id = current_org_id())'),
      ('ownership_transfers', '(organization_id = current_org_id())'),
      ('payments',            '(organization_id = current_org_id())'),
      ('rate_limit',          '(organization_id = current_org_id())'),
      ('services',            '(organization_id = current_org_id())'),
      ('staff',               '(organization_id = current_org_id())'),
      ('staff_availability',  '(staff_id IN ( SELECT staff.id FROM staff WHERE (staff.organization_id = current_org_id())))'),
      ('treatment_history',   '(customer_id IN ( SELECT customers.id FROM customers WHERE (customers.organization_id = current_org_id())))'),
      ('waitlist',            '(organization_id = current_org_id())')
    ) AS t(relname, expected_qual)
  LOOP
    SELECT count(*) FILTER (WHERE p.polpermissive),
           count(*)
      INTO n_permissive, n_policies
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = rec.relname;

    -- One permissive policy, and only one. A second one is ORed in and makes
    -- the first irrelevant.
    IF n_permissive <> 1 THEN
      RAISE EXCEPTION 'production-verify: % has % permissive policies (expected exactly 1) — permissive policies are ORed together, so any extra one overrides tenant isolation',
        rec.relname, n_permissive;
    END IF;
    IF n_policies <> 1 THEN
      RAISE EXCEPTION 'production-verify: % has % policies (expected exactly 1: tenant_isolation)',
        rec.relname, n_policies;
    END IF;

    SELECT p.polname, p.polcmd::text, p.polpermissive,
           regexp_replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), '\s+', ' ', 'g'),
           regexp_replace(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\s+', ' ', 'g'),
           coalesce((SELECT string_agg(r.rolname, ',' ORDER BY r.rolname)
                       FROM pg_roles r WHERE r.oid = ANY(p.polroles)), 'PUBLIC')
      INTO pol_name, pol_cmd, pol_permissive, pol_qual, pol_check, pol_roles
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = rec.relname;

    IF pol_name <> 'tenant_isolation' THEN
      RAISE EXCEPTION 'production-verify: %s single policy is named %, not tenant_isolation', rec.relname, pol_name;
    END IF;
    -- FOR ALL. A policy scoped to SELECT leaves INSERT/UPDATE/DELETE
    -- unrestricted, which no read-side probe would ever notice.
    IF pol_cmd <> '*' THEN
      RAISE EXCEPTION 'production-verify: % policy is FOR %, not FOR ALL — writes are unrestricted', rec.relname, pol_cmd;
    END IF;
    -- PUBLIC. A policy scoped to a role the app does not use applies to nobody.
    IF pol_roles <> 'PUBLIC' THEN
      RAISE EXCEPTION 'production-verify: % policy applies to roles % rather than PUBLIC — it does not constrain the application role', rec.relname, pol_roles;
    END IF;
    IF pol_qual <> rec.expected_qual THEN
      RAISE EXCEPTION 'production-verify: % USING clause is % but must be exactly % — a predicate that merely mentions current_org_id() can still be a tautology',
        rec.relname, pol_qual, rec.expected_qual;
    END IF;
    -- WITH CHECK is what blocks a cross-tenant INSERT. Losing it leaves reads
    -- isolated and writes wide open.
    IF pol_check <> rec.expected_qual THEN
      RAISE EXCEPTION 'production-verify: % WITH CHECK clause is % but must be exactly % — cross-tenant writes would be accepted',
        rec.relname, coalesce(nullif(pol_check, ''), '(absent)'), rec.expected_qual;
    END IF;
  END LOOP;

  -- 4d. Nothing carrying organization_id escapes classification. A tenant
  --     table added by a later migration and never given RLS lands here
  --     rather than going unnoticed until it leaks.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unclassified
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     AND EXISTS (SELECT 1 FROM information_schema.columns col
                  WHERE col.table_schema = 'public' AND col.table_name = c.relname
                    AND col.column_name = 'organization_id')
     AND NOT (c.relname = ANY(required_rels))
     AND NOT (c.relname = ANY(exempt_rels))
     -- audit_log partitions inherit the parent's policy; the parent is in
     -- required_rels and is where RLS is asserted.
     AND c.relname !~ '^audit_log_(\d{4}_\d{2}|default)$';
  IF unclassified IS NOT NULL THEN
    RAISE EXCEPTION 'production-verify: relation(s) carry organization_id but are neither RLS-protected nor a declared exemption: % — a tenant table was added without row-level security', unclassified;
  END IF;

  -- 4e. The exemption list itself is an assertion, so it must stay honest. If
  --     a declared exemption has vanished, the list is stale and the reasons
  --     recorded above no longer describe this database.
  SELECT string_agg(want, ', ' ORDER BY want) INTO exempt_drift
    FROM unnest(exempt_rels) AS want
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = want AND c.relkind IN ('r', 'p')
   );
  IF exempt_drift IS NOT NULL THEN
    RAISE EXCEPTION 'production-verify: declared RLS exemption(s) no longer exist: % — the exemption set does not match this schema', exempt_drift;
  END IF;

  n_required := array_length(required_rels, 1);
  RAISE NOTICE 'ok: all % required tenant relations have RLS enabled, FORCED, and exactly one permissive FOR ALL tenant_isolation policy whose USING and WITH CHECK match the expected predicate exactly; % declared exemptions intact',
    n_required, array_length(exempt_rels, 1);
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

-- 6. audit_log partitioning covers today and the maintenance horizon. -------
--
-- The previous version asserted only that at least one partition existed and
-- that audit_log_default was empty. Both hold for a database whose newest
-- partition is eight months old: `parts = 13` counts history, and the default
-- partition is empty right up until the first write that has nowhere else to
-- go. It reported "partitions ahead of today" while proving nothing about
-- today, and the first audit write of an uncovered month is the event that
-- turns that into a lost audit trail.
--
-- The horizon is the maintenance policy, stated once and asserted here:
-- app/api/cron/db-partitions/route.ts loops `i = 0..3`, so the current month
-- and the next three must always exist. Falling to two future months means the
-- job has stopped running and there are weeks, not months, of slack left.
DO $$
DECLARE
  horizon_months CONSTANT int := 3;  -- must match db-partitions/route.ts
  cur_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  want_month date;
  want_name text;
  bounds text[];
  lo timestamptz;
  hi timestamptz;
  default_rows bigint;
  attached int;
  overlap_pairs text;
  fn_exists bool;
  i int;
BEGIN
  -- 6a. The current month and every month out to the horizon exists, is
  --     attached to audit_log itself, and carries exactly the bounds its name
  --     claims. A partition named 2026_09 covering October is worse than a
  --     missing one: writes land silently in the wrong month.
  FOR i IN 0..horizon_months LOOP
    want_month := (cur_month + (i || ' months')::interval)::date;
    want_name := 'audit_log_' || to_char(want_month, 'YYYY_MM');

    SELECT regexp_match(pg_get_expr(ch.relpartbound, ch.oid),
                        'FROM \(''(.+?)''\) TO \(''(.+?)''\)')
      INTO bounds
      FROM pg_inherits inh
      JOIN pg_class p ON p.oid = inh.inhparent
      JOIN pg_class ch ON ch.oid = inh.inhrelid
      JOIN pg_namespace n ON n.oid = p.relnamespace
     WHERE n.nspname = 'public' AND p.relname = 'audit_log' AND ch.relname = want_name;

    IF bounds IS NULL THEN
      RAISE EXCEPTION 'production-verify: audit_log partition % is missing or not attached to audit_log — audit writes for % have nowhere to land except the default partition',
        want_name, to_char(want_month, 'YYYY-MM');
    END IF;

    lo := bounds[1]::timestamptz;
    hi := bounds[2]::timestamptz;
    IF lo <> want_month::timestamptz OR hi <> (want_month + interval '1 month')::timestamptz THEN
      RAISE EXCEPTION 'production-verify: audit_log partition % covers [%, %) but its name claims [%, %) — rows are being routed into the wrong month',
        want_name, lo, hi, want_month, want_month + interval '1 month';
    END IF;
  END LOOP;

  -- 6b. No two partitions claim the same instant. Postgres enforces this on
  --     ATTACH, so a violation here means the catalogue itself is damaged —
  --     which a restore can produce and nothing else would report.
  --     Column aliases are suffixed `_b`: bare `lo`/`hi` would collide with the
  --     PL/pgSQL variables above, which PL/pgSQL resolves in favour of the
  --     variable and turns the predicate into a constant.
  WITH parts AS (
    SELECT ch.relname AS pname,
           (regexp_match(pg_get_expr(ch.relpartbound, ch.oid), 'FROM \(''(.+?)''\) TO \(''(.+?)''\)'))[1]::timestamptz AS lo_b,
           (regexp_match(pg_get_expr(ch.relpartbound, ch.oid), 'FROM \(''(.+?)''\) TO \(''(.+?)''\)'))[2]::timestamptz AS hi_b
      FROM pg_inherits inh
      JOIN pg_class p ON p.oid = inh.inhparent
      JOIN pg_class ch ON ch.oid = inh.inhrelid
      JOIN pg_namespace n ON n.oid = p.relnamespace
     WHERE n.nspname = 'public' AND p.relname = 'audit_log'
       AND pg_get_expr(ch.relpartbound, ch.oid) <> 'DEFAULT'
  )
  SELECT string_agg(x.pname || ' overlaps ' || y.pname, ', ') INTO overlap_pairs
    FROM parts x JOIN parts y
      ON x.pname < y.pname AND x.lo_b < y.hi_b AND y.lo_b < x.hi_b;
  IF overlap_pairs IS NOT NULL THEN
    RAISE EXCEPTION 'production-verify: audit_log partitions overlap: %', overlap_pairs;
  END IF;

  -- 6c. The default partition is still empty. A row here is a month that had
  --     no partition when it was written — the horizon check above prevents
  --     it going forward, this proves it has not already happened.
  EXECUTE 'SELECT count(*) FROM public.audit_log_default' INTO default_rows;
  IF default_rows > 0 THEN
    RAISE EXCEPTION 'production-verify: % row(s) landed in audit_log_default — a month was missing its partition when those audit records were written', default_rows;
  END IF;

  -- 6d. The maintenance function still exists. Without it the cron endpoint
  --     500s every night and the horizon silently stops advancing; the first
  --     symptom would otherwise be 6a failing months later.
  SELECT EXISTS (
    SELECT 1 FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
     WHERE n.nspname = 'public' AND pr.proname = 'bp_create_monthly_partition'
       AND pg_get_function_identity_arguments(pr.oid) = 'parent regclass, month date'
  ) INTO fn_exists;
  IF NOT fn_exists THEN
    RAISE EXCEPTION 'production-verify: bp_create_monthly_partition(regclass, date) is missing — partition maintenance cannot run';
  END IF;

  SELECT count(*) INTO attached
    FROM pg_inherits inh JOIN pg_class p ON p.oid = inh.inhparent
   WHERE p.relname = 'audit_log';

  RAISE NOTICE 'ok: audit_log has % attached partitions; % and the next % months exist with correct bounds; audit_log_default is empty',
    attached, to_char(cur_month, 'YYYY-MM'), horizon_months;
END $$;

\echo '=== production invariants: ALL CHECKS PASSED ==='
