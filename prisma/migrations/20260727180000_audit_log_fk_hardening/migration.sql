-- =============================================================================
-- RBAC Phase 1 — harden audit_log against the append-only bypass surfaces
-- that migration 170000 left open.
--
-- Two loopholes surfaced during Phase 1 testing:
--
--   1. FK cascades. The pre-Phase-1 FKs on audit_log.actor_user_id and
--      audit_log.organization_id were ON DELETE SET NULL. Deleting an
--      app_user or organization silently UPDATEs the audit_log rows —
--      the append-only trigger correctly blocks it, but the intent is
--      wrong regardless. Spec §9.11 says audit rows survive their actor
--      being purged; that means the FK behaviour is NO ACTION (deletion
--      of a referenced user/org fails while any audit row points to it).
--
--      Practical consequence: GDPR "right to be forgotten" cannot
--      hard-delete a user with audit history. Instead the user's PII
--      fields on app_users are masked (email → hashed placeholder, name
--      → 'redacted', status → 'deleted'), and the FK stays intact so the
--      audit trail keeps its integrity. Documented in
--      docs/rbac-schema-notes.md.
--
--   2. TRUNCATE bypasses row-level triggers. audit_log_no_delete /
--      audit_log_no_update are ROW triggers; TRUNCATE fires only
--      STATEMENT triggers. A superuser TRUNCATE would wipe the log
--      silently. Add a BEFORE TRUNCATE trigger too.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Change FK ON DELETE from SET NULL to NO ACTION.
-- Drop-and-recreate is the only way in Postgres.
-- -----------------------------------------------------------------------------
ALTER TABLE "audit_log"
    DROP CONSTRAINT IF EXISTS "audit_log_actor_user_id_fkey",
    DROP CONSTRAINT IF EXISTS "audit_log_organization_id_fkey",
    DROP CONSTRAINT IF EXISTS "audit_log_on_behalf_of_user_id_fkey";

ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_user_id_fkey"
        FOREIGN KEY ("actor_user_id") REFERENCES "app_users"("id")
        ON DELETE NO ACTION ON UPDATE CASCADE,
    ADD CONSTRAINT "audit_log_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE NO ACTION ON UPDATE CASCADE,
    ADD CONSTRAINT "audit_log_on_behalf_of_user_id_fkey"
        FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "app_users"("id")
        ON DELETE NO ACTION ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- 2. BEFORE TRUNCATE trigger. Statement-level, fires on every TRUNCATE
-- attempt regardless of caller role. Cannot be silently bypassed —
-- disabling the trigger requires a DDL statement in a superuser session,
-- which leaves the same DDL trail as the DISABLE TRIGGER escape hatch
-- described in migration 170000.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_block_truncate() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'audit_log is append-only (spec §9.11): TRUNCATE is not permitted'
        USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "audit_log"
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_truncate();
