-- Customer waitlist for opened slots.
--
-- A row means "this customer wants an appointment at (staffId?, serviceId?)
-- somewhere in [preferred_from, preferred_to]". When an existing
-- appointment gets cancelled, waitlist entries whose (staff+service+window)
-- overlap the freed slot get a notification.
--
-- Design:
--   - staffId + serviceId are nullable so a customer can wait on "any staff
--     doing X service" or "specific staff, any service".
--   - status: pending | notified | fulfilled | expired.
--   - RLS + tenant_isolation (same shape as every other org-owned table).

CREATE TABLE "waitlist" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID           NOT NULL,
    "customer_id"     UUID           NOT NULL,
    "location_id"     UUID,
    "staff_id"        UUID,
    "service_id"      UUID,
    "preferred_from"  TIMESTAMPTZ(6) NOT NULL,
    "preferred_to"    TIMESTAMPTZ(6) NOT NULL,
    "status"          TEXT           NOT NULL DEFAULT 'pending'
        CHECK ("status" IN ('pending','notified','fulfilled','expired')),
    "notes"           TEXT,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "notified_at"     TIMESTAMPTZ(6),
    CONSTRAINT "waitlist_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "waitlist_org_fk"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
    CONSTRAINT "waitlist_customer_fk"
        FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE,
    CONSTRAINT "waitlist_location_fk"
        FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL,
    CONSTRAINT "waitlist_staff_fk"
        FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE SET NULL,
    CONSTRAINT "waitlist_service_fk"
        FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL,
    CONSTRAINT "waitlist_window_check" CHECK ("preferred_from" < "preferred_to")
);
CREATE INDEX "idx_waitlist_org_status"
    ON "waitlist" ("organization_id", "status");
CREATE INDEX "idx_waitlist_matcher"
    ON "waitlist" ("organization_id", "status", "preferred_from", "preferred_to");

ALTER TABLE "waitlist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waitlist" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "waitlist"
    USING       (organization_id = current_org_id())
    WITH CHECK  (organization_id = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "waitlist" TO bookpitch_app;
