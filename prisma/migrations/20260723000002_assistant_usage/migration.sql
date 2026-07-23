-- Per-org monthly assistant call counter. Used to cap LLM cost — cheap
-- lookup + increment on every /api/assistant/draft.
--
-- Design:
-- - Composite PK (organization_id, year_month) → one row per org per month.
-- - year_month stored as INT in YYYYMM form so upserts and comparisons stay
--   trivial without a DATE truncation function.
-- - Tenant-scoped RLS (same pattern as every other org-owned table).
-- - GRANTs to bookpitch_app so the app can INSERT/UPDATE/SELECT.

CREATE TABLE "assistant_usage" (
    "organization_id" UUID    NOT NULL,
    "year_month"      INT     NOT NULL,
    "count"           INT     NOT NULL DEFAULT 0,
    "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    CONSTRAINT "assistant_usage_pkey" PRIMARY KEY ("organization_id", "year_month"),
    CONSTRAINT "assistant_usage_org_fk"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "assistant_usage_year_month_check"
        CHECK ("year_month" BETWEEN 202001 AND 209912)
);

ALTER TABLE "assistant_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_usage" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "assistant_usage"
    USING       (organization_id = current_org_id())
    WITH CHECK  (organization_id = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "assistant_usage" TO bookpitch_app;
