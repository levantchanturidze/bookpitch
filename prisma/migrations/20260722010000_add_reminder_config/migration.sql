-- How many hours before an appointment the reminder tick should try to send.
-- Per-org so different clinics can pick their own default lead time.
ALTER TABLE "organizations"
    ADD COLUMN "reminder_lead_hours" SMALLINT NOT NULL DEFAULT 24;
