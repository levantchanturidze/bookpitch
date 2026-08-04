-- =============================================================================
-- SEC-007 end state: bookpitch_login role.
--
-- Purpose: shrink the blast radius of the auth hot path (buildAuthContext).
-- Today lib/rbac/context.ts uses unsafePrismaAdmin (postgres superuser) for
-- every authenticated request. If a bug ever routes an unrelated query
-- through that client (a customer read, an appointment lookup), it bypasses
-- RLS AND has grants on every table.
--
-- bookpitch_login has BYPASSRLS (necessary — buildAuthContext queries
-- memberships/organizations BEFORE org context is established, and RLS on
-- those tables filters by current_org_id() which isn't set yet) but has
-- SELECT grants ONLY on the ~7 tables the auth graph actually reads. Any
-- accidental query outside that set fails with `permission denied for
-- table X` at the Postgres layer.
--
-- This is a defense-in-depth win: the code path that runs on every single
-- request can no longer reach clinical records, customers, payments, or
-- audit_log. Even a buggy import at the top of a route handler that reused
-- the login client would surface immediately.
--
-- Password is deliberately NOT set here. The operator sets it manually in
-- the Supabase SQL editor after the migration lands:
--     ALTER USER bookpitch_login WITH PASSWORD '<generated>';
-- Then adds DATABASE_URL_LOGIN to Vercel with the pooled URL for this role.
-- Until both are done, lib/db.ts::prismaLogin falls back to unsafePrismaAdmin
-- transparently — no runtime behavior change.
--
-- Reversible via down.sql (drops the role + revokes the grants).
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookpitch_login') THEN
        -- LOGIN + BYPASSRLS + NO SUPERUSER + NO PASSWORD (operator sets later).
        CREATE ROLE bookpitch_login WITH
            LOGIN
            BYPASSRLS
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION
            NOINHERIT;
    END IF;
END $$;

-- Connection + schema access. GRANT ... ON DATABASE takes an identifier, not
-- an expression, so build the statement dynamically to get the current db.
DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO bookpitch_login', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO bookpitch_login;

-- SELECT grants — auth graph only. Every one is documented at its callsite
-- in lib/rbac/context.ts::buildAuthContext.
GRANT SELECT ON "app_users"                TO bookpitch_login;  -- caller identity
GRANT SELECT ON "memberships"              TO bookpitch_login;  -- caller's memberships
GRANT SELECT ON "organizations"            TO bookpitch_login;  -- org.status + features
GRANT SELECT ON "roles"                    TO bookpitch_login;  -- role key + rank
GRANT SELECT ON "role_permissions"         TO bookpitch_login;  -- permission bundle
GRANT SELECT ON "membership_branches"      TO bookpitch_login;  -- branch scope
GRANT SELECT ON "impersonation_sessions"   TO bookpitch_login;  -- Phase 5 impersonation
GRANT SELECT ON "break_glass_sessions"     TO bookpitch_login;  -- Phase 5 break-glass

-- Explicit REVOKE ALL from every other tenant table, in case a future
-- table-wide GRANT (e.g. GRANT SELECT ON ALL TABLES IN SCHEMA public)
-- ever fires. Belt-and-braces.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'customers','appointments','staff','staff_availability',
        'services','locations','branches','payments','message_templates',
        'message_log','notifications','treatment_history','waitlist',
        'audit_log','invitations','ownership_transfers','clinical_notes',
        'clinical_note_attachments','insurance_claims','push_subscriptions',
        'assistant_calls','platform_role_permissions','verification_tokens',
        'accounts','sessions'
    ]
    LOOP
        -- Some tables may not exist yet in older environments; ignore misses.
        BEGIN
            EXECUTE format('REVOKE ALL ON %I FROM bookpitch_login;', t);
        EXCEPTION WHEN undefined_table THEN
            NULL;
        END;
    END LOOP;
END $$;

-- Do NOT grant sequence usage or any write permission. bookpitch_login is
-- read-only on the auth graph. If future changes need a write path (e.g.
-- bump sessionVersion), keep that on unsafePrismaAdmin — this role stays
-- read-only.

COMMENT ON ROLE bookpitch_login IS
    'SEC-007: narrow auth-graph role for buildAuthContext. BYPASSRLS + SELECT '
    'on ~8 tables. See prisma/migrations/20260804000000_bookpitch_login_role.';
