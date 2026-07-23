-- Per-org sliding-window(ish) rate limiter. We use fixed 1-minute windows
-- keyed by the epoch-minute — cheap upsert path, easy to reason about.
--
-- Storage: rate_limit(organization_id, bucket, window_start, count).
-- - bucket is a short string ("assistant", "messaging", …) so we can share
--   the table across features without a schema change per new limiter.
-- - window_start is truncated to the minute (UTC).
-- - Row TTL is implicit: old rows just sit there until the housekeeping
--   cron prunes them. Storage cost is trivial (< a few KB per org per day).

CREATE TABLE "rate_limit" (
    "organization_id" UUID           NOT NULL,
    "bucket"          TEXT           NOT NULL,
    "window_start"    TIMESTAMPTZ(0) NOT NULL,
    "count"           INT            NOT NULL DEFAULT 0,
    CONSTRAINT "rate_limit_pkey" PRIMARY KEY ("organization_id", "bucket", "window_start"),
    CONSTRAINT "rate_limit_org_fk"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
CREATE INDEX "idx_rate_limit_window" ON "rate_limit" ("window_start");

ALTER TABLE "rate_limit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_limit" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "rate_limit"
    USING       (organization_id = current_org_id())
    WITH CHECK  (organization_id = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limit" TO bookpitch_app;
