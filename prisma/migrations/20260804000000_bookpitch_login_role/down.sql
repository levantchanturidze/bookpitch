-- Reverse SEC-007 narrow-role migration. Revoke all grants, then drop the
-- role. Safe to run against a DB where the role was never created (all
-- statements are guarded).

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookpitch_login') THEN
        REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM bookpitch_login;
        REVOKE USAGE ON SCHEMA public FROM bookpitch_login;
        EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM bookpitch_login', current_database());
        DROP ROLE bookpitch_login;
    END IF;
END $$;
