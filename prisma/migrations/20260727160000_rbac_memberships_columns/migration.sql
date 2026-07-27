-- =============================================================================
-- RBAC Phase 1 — extend `memberships` with spec §3 columns.
-- Runs AFTER `roles` exists so `role_id` can hold its FK.
--
-- EXPAND-only: the existing `role` (user_role enum) column stays and the
-- existing unique index (organization_id, user_id) stays. Phase 2 backfills
-- `role_id` from `role`, Phase 4 flips reads, and only much later (Contract)
-- does the enum column go.
--
-- Uniqueness during the transition:
--   • Existing invariant: one role per (org, user). Enforced by
--     `memberships_organization_id_user_id_key` (from 20260721220810_init).
--   • New invariant (post-Phase 2): one row per (user, org, role_id).
--     Enforced by a partial unique index below that only kicks in once
--     role_id is populated. This lets the same user hold multiple
--     memberships in the same org as long as role_id differs — the
--     spec §2.3 solo-practitioner and moonlighting-provider cases.
-- =============================================================================

ALTER TABLE "memberships"
    -- Points to a roles.id (system or custom). Nullable during expand;
    -- backfilled by Phase 2 from the existing `role` enum.
    ADD COLUMN "role_id"            UUID,
    -- Membership lifecycle. 'active' preserves existing behaviour — every
    -- current row was implicitly active. 'invited' becomes meaningful in
    -- Phase 6's invitation rewrite; 'suspended' / 'removed' in staff mgmt.
    ADD COLUMN "status"             TEXT           NOT NULL DEFAULT 'active',
    -- Shows in the scheduler as a bookable resource. Spec §3. PROVIDER +
    -- SENIOR_PROVIDER default true after Phase 4 wires this up; everyone
    -- else default false.
    ADD COLUMN "is_bookable"        BOOLEAN        NOT NULL DEFAULT false,
    -- Audit trail for invitations. NULL for the founding owner and for
    -- rows created before Phase 6.
    ADD COLUMN "invited_by_user_id" UUID,
    -- Distinguishes "sent invitation" from "invitation accepted". NULL
    -- during 'invited' state; set at accept-time.
    ADD COLUMN "joined_at"          TIMESTAMPTZ(6),
    ADD CONSTRAINT "memberships_role_id_fkey"
        FOREIGN KEY ("role_id") REFERENCES "roles"("id")
        -- RESTRICT: never let a role be deleted while any membership
        -- points at it. Forces a deliberate migration if a role is
        -- retired later.
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "memberships_invited_by_user_id_fkey"
        FOREIGN KEY ("invited_by_user_id") REFERENCES "app_users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "memberships_status_check"
        CHECK ("status" IN ('invited','active','suspended','removed'));

-- Future canonical uniqueness. Partial so it does not clash with rows
-- still holding role_id = NULL (pre-Phase-2 state).
CREATE UNIQUE INDEX "memberships_user_org_role_unique"
    ON "memberships"("user_id","organization_id","role_id")
    WHERE "role_id" IS NOT NULL;

-- Query indexes for the hot paths spec §10 will hit every request.
-- (user_id alone is already indexed via idx_memberships_user from init.
--  (org_id, user_id) is covered by the existing unique index.)
CREATE INDEX "idx_memberships_org_status" ON "memberships"("organization_id","status");
CREATE INDEX "idx_memberships_role_id"
    ON "memberships"("role_id") WHERE "role_id" IS NOT NULL;
