-- Migration: platform_security_hardening
--
-- Addendum to 20260806000000_platform_security:
--
-- 1. Revoke bookpitch_login access to the new platform tables so the narrow
--    auth-graph role (SEC-007) cannot reach platform security state.
--    The reauth grant and rate-limit table are platform-internal; bookpitch_login
--    needs no access and should not be able to read or write them.
--
-- 2. Add expiry index for platform_rate_limit cleanup. The housekeeping cron
--    (app/api/cron/housekeeping) will DELETE rows older than 2 hours using
--    this index. Without cleanup, old rate-limit windows accumulate indefinitely.
--
-- Rollback: GRANT SELECT, INSERT, UPDATE, DELETE ON platform_rate_limit,
--           platform_reauth_grant TO bookpitch_login;
--           DROP INDEX IF EXISTS idx_platform_rate_limit_expires;

-- ── 1. Revoke bookpitch_login from platform security tables ────────────────
DO $$
BEGIN
    -- Revoke only if the role exists (guards against fresh-install without the
    -- bookpitch_login role created yet — the bookpitch_login migration is
    -- idempotent and will create it on next apply).
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookpitch_login') THEN
        REVOKE ALL ON platform_rate_limit   FROM bookpitch_login;
        REVOKE ALL ON platform_reauth_grant FROM bookpitch_login;
    END IF;
END $$;

-- ── 2. Note on rate-limit cleanup ─────────────────────────────────────────
-- The housekeeping cron deletes rows where window_start < now() - INTERVAL '2 hours'.
-- The existing idx_platform_rate_limit_window (on window_start) already covers
-- this scan efficiently. No additional index is required: PostgreSQL cannot use
-- now() in a partial index predicate (VOLATILE function restriction), and a
-- plain index on window_start is already present.
