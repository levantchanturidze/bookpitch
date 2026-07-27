-- Rollback for 20260727180000_audit_log_fk_hardening.
DROP TRIGGER  IF EXISTS audit_log_no_truncate ON "audit_log";
DROP FUNCTION IF EXISTS audit_log_block_truncate();

ALTER TABLE "audit_log"
    DROP CONSTRAINT IF EXISTS "audit_log_actor_user_id_fkey",
    DROP CONSTRAINT IF EXISTS "audit_log_organization_id_fkey",
    DROP CONSTRAINT IF EXISTS "audit_log_on_behalf_of_user_id_fkey";

ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_user_id_fkey"
        FOREIGN KEY ("actor_user_id") REFERENCES "app_users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "audit_log_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "audit_log_on_behalf_of_user_id_fkey"
        FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "app_users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
