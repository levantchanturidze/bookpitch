-- Rollback for 20260902000001_cron_heartbeat_outcome.
--
-- Safe at any time: /api/health/ops reports the outcome fields as null when
-- they are absent, and the monitor reads a null outcome as "this deployment
-- predates the metric" rather than as a failure.
ALTER TABLE public.cron_heartbeat DROP CONSTRAINT IF EXISTS cron_heartbeat_outcome_check;
ALTER TABLE public.cron_heartbeat
  DROP COLUMN IF EXISTS last_outcome,
  DROP COLUMN IF EXISTS last_attempted_at,
  DROP COLUMN IF EXISTS last_expected_units,
  DROP COLUMN IF EXISTS last_failed_units;
