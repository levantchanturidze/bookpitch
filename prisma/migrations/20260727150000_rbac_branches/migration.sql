-- =============================================================================
-- RBAC Phase 1 — branches + membership_branches.
--
-- `branches` is the spec §3 replacement for today's `locations`. EXPAND-only
-- so `locations` stays untouched; Phase 2 backfills one branch per location
-- and Phase 4 flips reads over. `legacy_location_id` is the back-pointer
-- that makes the backfill (and rollback) idempotent.
--
-- `membership_branches` scopes a membership to a subset of branches — used
-- by BRANCH_MANAGER and multi-branch FRONT_DESK. Absent membership_branches
-- row means "unrestricted within the org" (interpreted by `can()` in Phase 3).
-- =============================================================================

CREATE TABLE "branches" (
    "id"                 UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id"    UUID           NOT NULL,
    "name"               TEXT           NOT NULL,
    "address"            TEXT,
    "timezone"           TEXT           NOT NULL DEFAULT 'Asia/Tbilisi',
    "status"             TEXT           NOT NULL DEFAULT 'active',
    -- Back-pointer to the `locations` row that this branch replaces.
    -- Set by Phase 2 backfill; NULL for org-created branches thereafter.
    -- ON DELETE SET NULL keeps the branch alive if the legacy row is
    -- ever purged (which shouldn't happen until Contract, months later).
    "legacy_location_id" UUID,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "branches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "branches_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "branches_legacy_location_id_fkey"
        FOREIGN KEY ("legacy_location_id") REFERENCES "locations"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "branches_status_check"
        CHECK ("status" IN ('active','inactive'))
);

CREATE INDEX "idx_branches_org" ON "branches"("organization_id");
-- Enforced 1:1 between legacy `locations` and new `branches` (once backfilled).
CREATE UNIQUE INDEX "branches_legacy_location_id_unique"
    ON "branches"("legacy_location_id") WHERE "legacy_location_id" IS NOT NULL;

-- Tenant isolation, matching the pattern in 20260722000002_add_rls.
ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branches" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "branches"
    USING       (organization_id = current_org_id())
    WITH CHECK  (organization_id = current_org_id());

-- updated_at trigger (function defined in 20260721220810_init).
CREATE TRIGGER trg_branches_updated BEFORE UPDATE ON "branches"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- membership_branches — scoping subset for a membership.
-- -----------------------------------------------------------------------------
CREATE TABLE "membership_branches" (
    "membership_id" UUID           NOT NULL,
    "branch_id"     UUID           NOT NULL,
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "membership_branches_pkey" PRIMARY KEY ("membership_id","branch_id"),
    CONSTRAINT "membership_branches_membership_id_fkey"
        FOREIGN KEY ("membership_id") REFERENCES "memberships"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "membership_branches_branch_id_fkey"
        FOREIGN KEY ("branch_id") REFERENCES "branches"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_membership_branches_branch" ON "membership_branches"("branch_id");

-- No organization_id column here: derive tenancy through the parent branch
-- (mirrors staff_availability / treatment_history in 20260722000002).
ALTER TABLE "membership_branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_branches" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "membership_branches"
    USING (branch_id IN (SELECT id FROM branches WHERE organization_id = current_org_id()))
    WITH CHECK (branch_id IN (SELECT id FROM branches WHERE organization_id = current_org_id()));
