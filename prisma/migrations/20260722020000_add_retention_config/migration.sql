-- Customer PII retention window (years). After no updates + no appointments
-- in this many years, the retention tick anonymizes the customer row.
-- 7 years matches Georgia's health-record retention baseline + HIPAA norms.
ALTER TABLE "organizations"
    ADD COLUMN "customer_retention_years" SMALLINT NOT NULL DEFAULT 7;
