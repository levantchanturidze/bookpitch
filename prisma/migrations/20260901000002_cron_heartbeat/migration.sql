-- Application-side proof that a cron job actually RAN.
--
-- Everything the monitor knew about cron health came from the GitHub Actions
-- runs list: "a workflow was queued and its curl exited 0". That is a fact
-- about GitHub, not about Bookpitch. It stays green if the endpoint returns
-- 200 without doing any work, and it says nothing at all if some future
-- scheduler replaces the workflow.
--
-- The gap that matters is between INVOCATION and COMPLETION. `POST
-- /api/cron/reminders` can return 200 having processed zero organizations —
-- the only record of what it did was a log line nobody reads. So the last
-- successful completion of each job is now written down, by the job itself,
-- in the same database the monitor already reads through /api/health/ops.
--
-- Deliberately tiny and scheduler-agnostic: one row per job, overwritten in
-- place. It is a heartbeat, not a history — audit_log is where durable
-- records belong, and duplicating them here would create a second retention
-- surface for no benefit.
--
-- Not tenant-scoped: a cron tick spans every organization, so there is no
-- organization_id and no RLS policy. It is operational metadata, holds no
-- customer data, and is listed as such in
-- scripts/verify-production-invariants.sql check 4 (it carries no
-- organization_id, so it is outside that check's population by construction).
--
-- ROLLBACK
--   DROP TABLE IF EXISTS public.cron_heartbeat;
--   Safe at any time: nothing reads it except the ops metrics endpoint, which
--   reports null for an absent row, and the monitor treats a null heartbeat as
--   "this deployment predates the metric" rather than as a failure.

CREATE TABLE IF NOT EXISTS public.cron_heartbeat (
    job                text        PRIMARY KEY,
    last_succeeded_at  timestamptz NOT NULL,
    -- Small, numeric, non-identifying summary of the last run: how much work
    -- it did. Lets the monitor tell "ran and processed 6 organizations" from
    -- "ran and silently processed none".
    last_units         integer     NOT NULL DEFAULT 0
);

-- The app role writes its own heartbeat, so it needs UPDATE here. This is the
-- deliberate opposite of audit_log, and the reason the two are separate
-- tables: a heartbeat is meant to be overwritten, an audit record never is.
GRANT SELECT, INSERT, UPDATE ON public.cron_heartbeat TO bookpitch_app;
