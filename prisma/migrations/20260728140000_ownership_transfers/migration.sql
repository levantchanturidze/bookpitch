-- =============================================================================
-- RBAC Phase 6 — org ownership transfer flow (spec §4.2 + §9 rule 1).
--
-- Two-step: the current ORG_OWNER nominates a member; that member either
-- accepts (roles swap in a single tx) or declines / lets it expire (no
-- change). One pending transfer per org at a time — partial unique index
-- below.
--
-- Not RLS'd. Queried by lib/admin/ownership-transfer.ts which is called
-- from route handlers already scoped by requirePermission. Actor + target
-- FKs use ON DELETE NO ACTION — the row is evidence of the intent even if
-- one party is later deleted (same rationale as audit_log). Org FK CASCADE
-- because a transfer is meaningless once the org is gone.
-- =============================================================================

CREATE TABLE "ownership_transfers" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID           NOT NULL,
    "from_user_id"    UUID           NOT NULL,
    "to_user_id"      UUID           NOT NULL,
    "status"          TEXT           NOT NULL DEFAULT 'pending',
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"      TIMESTAMPTZ(6) NOT NULL,
    "decided_at"      TIMESTAMPTZ(6),
    "decided_reason"  TEXT,
    CONSTRAINT "ownership_transfers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ownership_transfers_org_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ownership_transfers_from_fkey"
        FOREIGN KEY ("from_user_id") REFERENCES "app_users"("id")
        ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "ownership_transfers_to_fkey"
        FOREIGN KEY ("to_user_id") REFERENCES "app_users"("id")
        ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "ownership_transfers_status_check"
        CHECK ("status" IN ('pending','accepted','declined','expired','revoked')),
    CONSTRAINT "ownership_transfers_distinct"
        CHECK ("from_user_id" <> "to_user_id"),
    CONSTRAINT "ownership_transfers_expires_future"
        CHECK ("expires_at" > "created_at")
);

-- One pending transfer per org at a time. Partial so accepted / declined
-- rows accumulate as history without blocking a fresh nomination.
CREATE UNIQUE INDEX "ownership_transfers_one_pending_per_org"
    ON "ownership_transfers"("organization_id") WHERE "status" = 'pending';

-- Hot query: "am I the target of a pending transfer?" — the nominee's
-- notifications list pulls this on every page load.
CREATE INDEX "idx_ownership_transfers_to_pending"
    ON "ownership_transfers"("to_user_id") WHERE "status" = 'pending';

-- Tenant isolation (matches 20260722000002_add_rls pattern). Ownership
-- transfers are org-scoped and readable by org members; prismaApp
-- callers that forget withOrg() get filtered.
ALTER TABLE "ownership_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ownership_transfers" FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ownership_transfers"
    USING       (organization_id = current_org_id())
    WITH CHECK  (organization_id = current_org_id());
