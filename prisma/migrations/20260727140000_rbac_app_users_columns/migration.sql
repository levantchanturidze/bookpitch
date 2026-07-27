-- =============================================================================
-- RBAC Phase 1 — extend `app_users` with spec §3 columns.
-- Runs AFTER `roles` exists so `platform_role_id` can hold its FK.
-- =============================================================================

ALTER TABLE "app_users"
    -- Lifecycle. 'locked' = admin-blocked signin; 'deleted' = soft-deleted
    -- pending purge. Default 'active' preserves existing behaviour.
    ADD COLUMN "status"           TEXT           NOT NULL DEFAULT 'active',
    -- Preferred UI locale ('en', 'ka', …). Nullable → the app falls back
    -- to browser Accept-Language.
    ADD COLUMN "locale"           TEXT,
    -- Enforced 2FA marker for platform-plane accounts (spec §7.2 root
    -- account pattern). Default false; SUPER_ADMIN policy will require
    -- true (enforced by Phase 5, seeded true in Phase 1's SUPER_ADMIN row).
    ADD COLUMN "mfa_enabled"      BOOLEAN        NOT NULL DEFAULT false,
    -- Updated by the login callback so the platform can show recent
    -- activity and flag dormant accounts.
    ADD COLUMN "last_login_at"    TIMESTAMPTZ(6),
    -- Optional pointer to a role in the PLATFORM plane. Users without
    -- one are org-plane only (that is, everyone today). Only referenced
    -- by the auth core when the caller crosses org boundaries.
    ADD COLUMN "platform_role_id" UUID,
    ADD CONSTRAINT "app_users_status_check"
        CHECK ("status" IN ('active','locked','deleted')),
    ADD CONSTRAINT "app_users_platform_role_id_fkey"
        FOREIGN KEY ("platform_role_id") REFERENCES "roles"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "idx_app_users_status" ON "app_users"("status");
CREATE INDEX "idx_app_users_platform_role"
    ON "app_users"("platform_role_id") WHERE "platform_role_id" IS NOT NULL;
