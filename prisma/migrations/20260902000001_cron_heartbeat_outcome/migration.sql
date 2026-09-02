-- A heartbeat must record what the run DID, not merely that it ended.
--
-- cron_heartbeat as first shipped stored only `last_succeeded_at` and
-- `last_units`, and the routes wrote it unconditionally. The reminders route
-- passed the count of organizations that happened to succeed, so a tick in
-- which all ten organizations threw wrote a fresh `last_succeeded_at` with
-- `last_units = 0` and the monitor reported a healthy job. The endpoint also
-- returned 200, so the workflow was green too. Three independent signals, all
-- reporting health, none of them measuring whether the work happened.
--
-- Forward-only and additive. Existing rows keep their timestamps; the new
-- columns default to a state that reads as "this row predates outcome
-- tracking" rather than as a success:
--
--   last_outcome        'unknown' — not 'success'. Backfilling optimism into
--                       history is how a metric starts lying about the past.
--   last_attempted_at   NULL — no attempt is recorded for old rows.
--   last_expected_units NULL, last_failed_units NULL — unknown, not zero.
--
-- `last_succeeded_at` now only advances on a success, so a partial or failed
-- run leaves the previous success timestamp in place and the monitor keeps
-- ageing from the last time the job genuinely worked.
--
-- ROLLBACK
--   ALTER TABLE public.cron_heartbeat
--     DROP COLUMN IF EXISTS last_outcome,
--     DROP COLUMN IF EXISTS last_attempted_at,
--     DROP COLUMN IF EXISTS last_expected_units,
--     DROP COLUMN IF EXISTS last_failed_units;
--   Safe: /api/health/ops reports the outcome fields as null when absent, and
--   the monitor treats a null outcome as "this deployment predates the metric"
--   rather than as a failure.

ALTER TABLE public.cron_heartbeat
  ADD COLUMN IF NOT EXISTS last_outcome        text        NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS last_attempted_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_expected_units integer,
  ADD COLUMN IF NOT EXISTS last_failed_units   integer;

-- Only the four outcomes the application can produce. A typo in a future
-- writer becomes a constraint violation rather than a silently unmatched
-- string that the monitor would read as "not success" or "not failure"
-- depending on which way it happened to compare.
ALTER TABLE public.cron_heartbeat
  DROP CONSTRAINT IF EXISTS cron_heartbeat_outcome_check;
ALTER TABLE public.cron_heartbeat
  ADD CONSTRAINT cron_heartbeat_outcome_check
  CHECK (last_outcome IN ('success', 'partial', 'failure', 'unknown'));
