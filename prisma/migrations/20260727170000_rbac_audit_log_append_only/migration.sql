-- =============================================================================
-- RBAC Phase 1 — audit_log becomes append-only + spec §7.1 columns.
--
-- Two concerns bundled because they touch the same table and share a
-- rollback: (1) grow the row shape to hold impersonation + break-glass
-- metadata; (2) enforce spec invariant §9.11 — no UPDATE, no DELETE, for
-- anyone, including SUPER_ADMIN.
--
-- Enforcement layers (defense in depth):
--   1. REVOKE UPDATE, DELETE ON audit_log FROM bookpitch_app on the parent
--      AND every partition (grants don't cascade). This means an app-role
--      connection cannot even attempt the mutation.
--   2. BEFORE UPDATE / BEFORE DELETE trigger on the parent that raises
--      unconditionally. Row-level triggers on a PARTITIONED parent apply
--      to every partition automatically (PG13+). Superuser connections
--      hit this too — the trigger fires regardless of role.
--   3. Update `bp_create_monthly_partition()` so partitions created by
--      the rollover cron start out with UPDATE/DELETE revoked. Without
--      this the schema-wide ALTER DEFAULT PRIVILEGES (migration
--      20260722000003) would grant them back.
--
-- What this DOES survive:
--   • Any application code path, including code accidentally connecting
--     as the admin role.
--   • Any query written by future maintainers.
--
-- What this does NOT survive:
--   • A superuser explicitly running ALTER TABLE audit_log DISABLE TRIGGER,
--     mutating, then re-enabling. The DDL leaves a trail in pg_stat and
--     the audit log of the DB itself (Supabase's platform audit) — the
--     spec accepts that this is the appropriate escape hatch because
--     the friction is high and the operation is unmistakable in review.
--   • DROP TABLE audit_log CASCADE by a superuser wipes everything. The
--     database owner has ultimate power; the only mitigation is external
--     (WORM storage, off-site copy). Called out in docs/rbac-schema-notes.md.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extend the row shape for impersonation + break-glass metadata (spec §7.1).
-- -----------------------------------------------------------------------------
ALTER TABLE "audit_log"
    -- Set when an actor is impersonating another user (spec §7.1). The
    -- actor is Bookpitch staff; on_behalf_of is the org member whose
    -- account they entered.
    ADD COLUMN "on_behalf_of_user_id"     UUID,
    -- Captured verbatim from the request headers. TEXT because
    -- User-Agent has no length ceiling in the RFC.
    ADD COLUMN "user_agent"               TEXT,
    -- Free text explaining the action, mandatory for impersonation and
    -- break-glass. TEXT (no length cap) — spec §7 wants a rich record.
    ADD COLUMN "reason"                   TEXT,
    -- FK to a future impersonation_sessions table. Column added now so
    -- the audit-write path in Phase 5 does not need a schema change.
    ADD COLUMN "impersonation_session_id" UUID,
    ADD COLUMN "break_glass_session_id"   UUID,
    ADD CONSTRAINT "audit_log_on_behalf_of_user_id_fkey"
        FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "app_users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- 2. Append-only enforcement.
-- -----------------------------------------------------------------------------
-- 2a. Trigger. Fires for every role, blocks every UPDATE and DELETE.
CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'audit_log is append-only (spec §9.11): % is not permitted', TG_OP
        USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON "audit_log"
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON "audit_log"
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

-- 2b. Revoke UPDATE + DELETE on the parent and every existing partition.
REVOKE UPDATE, DELETE ON "audit_log" FROM bookpitch_app;
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
        EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM bookpitch_app', p_name);
    END LOOP;
END $$;

-- 2c. Update the rollover helper so future partitions inherit the ban.
--   The schema-wide ALTER DEFAULT PRIVILEGES from 20260722000003 will
--   grant UPDATE/DELETE by default on any new table; we revoke them
--   immediately for audit_log's partitions.
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
    -- Append-only invariant: revoke mutation grants that the schema-wide
    -- default would otherwise hand to bookpitch_app.
    IF parent::text = 'audit_log' THEN
        EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM bookpitch_app', part_name);
    END IF;
END;
$$ LANGUAGE plpgsql;
