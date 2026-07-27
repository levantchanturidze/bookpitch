-- =============================================================================
-- RBAC Phase 1 — extend `organizations` with spec §3 columns.
-- EXPAND-only: nothing existing is altered or dropped. Every column is additive
-- and nullable, or has a default that is a no-op for existing rows.
--
-- Backfill happens in Phase 2. During the transition, application code keeps
-- reading the old shape; new columns stay NULL until backfilled.
-- =============================================================================

ALTER TABLE "organizations"
    -- Per-org vertical marker. Spec §3: `vertical` moves to the org from
    -- location.type. Nullable until Phase 2 backfills each org from its
    -- first (or only) location's type. CHECK constraint keeps the domain
    -- small.
    ADD COLUMN "vertical"                    TEXT,
    -- Human-facing brand name vs. registered legal name. Both nullable
    -- because a solo practitioner may only have one of them.
    ADD COLUMN "legal_name"                  TEXT,
    ADD COLUMN "brand_name"                  TEXT,
    -- Lifecycle status per spec §3. Default 'active' preserves current
    -- behaviour — everything today is implicitly active. 'trial' /
    -- 'suspended' / 'archived' become meaningful in Phase 5.
    ADD COLUMN "status"                      TEXT       NOT NULL DEFAULT 'active',
    -- Explicit pointer to the ORG_OWNER for O(1) invariant checks.
    -- Nullable during expand: Phase 2 backfills from the first
    -- memberships row with role='owner'. Kept in sync going forward by
    -- Phase 6 code (ownership transfer, last-owner guard).
    ADD COLUMN "owner_user_id"               UUID,
    -- Per-org opt-in for platform support impersonation (spec §7.1).
    -- Default false = closed. Medical clients contractually require it
    -- to be off; opting in is an explicit org action.
    ADD COLUMN "allow_support_impersonation" BOOLEAN    NOT NULL DEFAULT false,
    ADD CONSTRAINT "organizations_owner_user_id_fkey"
        FOREIGN KEY ("owner_user_id") REFERENCES "app_users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "organizations_status_check"
        CHECK ("status" IN ('trial','active','suspended','archived')),
    ADD CONSTRAINT "organizations_vertical_check"
        CHECK ("vertical" IS NULL OR "vertical" IN ('clinic','salon','fitness','mixed'));

CREATE INDEX "idx_org_status"        ON "organizations"("status");
CREATE INDEX "idx_org_owner_user_id" ON "organizations"("owner_user_id");
