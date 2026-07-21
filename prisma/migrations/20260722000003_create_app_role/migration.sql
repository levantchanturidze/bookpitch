-- =============================================================================
-- Create a non-superuser Postgres role for the application to connect as.
--
-- Why: Postgres SUPERUSERs (and roles with BYPASSRLS) skip Row-Level Security
-- unconditionally, even with FORCE ROW LEVEL SECURITY set. Our local dev DB
-- runs as the OS user (superuser), which would mean RLS is a no-op for the
-- app. The `bookpitch_app` role solves that: it has full DML on tenant tables
-- but no bypass, so RLS policies from 20260722000002_add_rls actually apply.
--
-- On Supabase / production, the equivalent is the `authenticated` role.
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookpitch_app') THEN
        CREATE ROLE bookpitch_app LOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
END $$;

-- Schema access.
GRANT USAGE ON SCHEMA public TO bookpitch_app;

-- DML on all existing tables + read on sequences (uuid PKs need none, but
-- audit_log uses BIGSERIAL).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bookpitch_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bookpitch_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO bookpitch_app;

-- Ensure any future tables/sequences/functions (added by later migrations)
-- inherit the same grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bookpitch_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO bookpitch_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO bookpitch_app;
