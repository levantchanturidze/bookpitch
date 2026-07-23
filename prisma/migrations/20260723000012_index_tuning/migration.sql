-- Index tuning + pg_stat_statements enablement.
--
-- Extension: pg_stat_statements ships with every Neon/Supabase Postgres.
-- Once enabled, `SELECT query, calls, total_exec_time, mean_exec_time
--   FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;`
-- surfaces the actual hot queries so future migrations can be targeted.
-- Docs live at docs/perf.md.
--
-- The indexes below cover query shapes we know exist from grepping the
-- codebase; they're not speculative. Each maps to a specific findMany /
-- findFirst call in lib/*.ts.

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- message_log: two hot paths.
-- (1) sendForAppointment() checks WHERE appointment_id = ? AND channel = ?
--     AND state IN ('queued','sent','delivered'). Existing schema has no
--     compound index for this — appointment_id alone forces a full scan
--     of an appointment's message history.
CREATE INDEX IF NOT EXISTS "idx_message_log_appt_channel_state"
    ON "message_log" ("appointment_id", "channel", "state");

-- (2) gdpr export lists all messages for a customer's appointments.
--     WHERE appointment_id IN (…). Covered by (appointment_id) already.

-- notifications: header polls every 30s WHERE organization_id = ?
-- ORDER BY created_at DESC LIMIT 20. There's already
-- idx_notifications_org via raw SQL, but only on (org_id, created_at DESC).
-- The read filter is org + created_at, so keep as-is. Add a partial index
-- for the unread badge count (much smaller than the full table).
CREATE INDEX IF NOT EXISTS "idx_notifications_org_unread"
    ON "notifications" ("organization_id")
    WHERE "read" = false;

-- payments: analytics + list per appointment.
-- lib/analytics.ts sums by day WHERE organization_id = ? AND paid_at >= ?
CREATE INDEX IF NOT EXISTS "idx_payments_org_paidat"
    ON "payments" ("organization_id", "paid_at" DESC)
    WHERE "paid_at" IS NOT NULL;

-- appointments: analytics windows commonly filter (location_id, status,
-- starts_at). idx_appt_location_day covers (location_id, starts_at) but
-- when status='completed' is added we still scan the range. A partial
-- helps the "revenue by day" chart.
CREATE INDEX IF NOT EXISTS "idx_appointments_completed_org_starts"
    ON "appointments" ("organization_id", "starts_at")
    WHERE "status" = 'completed';

-- rate_limit housekeeping runs DELETE WHERE window_start < ? — covered
-- by idx_rate_limit_window from the rate_limit migration.

-- invitations status filter — already covered by idx_invitations_org_status.

-- waitlist matcher — already covered by idx_waitlist_matcher.
