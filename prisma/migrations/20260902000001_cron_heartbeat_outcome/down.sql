-- Rollback for 20260902000001_cron_heartbeat_outcome.
--
-- Safe at any time: /api/health/ops reports the outcome fields as null when
-- they are absent, and the monitor reads a null outcome as "this deployment
-- predates the metric" rather than as a failure.
ALTER TABLE public.cron_heartbeat DROP CONSTRAINT IF EXISTS cron_heartbeat_outcome_check;
-- Rows that never succeeded carry NULL, which the original NOT NULL column
-- cannot hold; give them the epoch so the constraint can be restored.
UPDATE public.cron_heartbeat SET last_succeeded_at = 'epoch' WHERE last_succeeded_at IS NULL;
ALTER TABLE public.cron_heartbeat ALTER COLUMN last_succeeded_at SET NOT NULL;

ALTER TABLE public.cron_heartbeat
  DROP COLUMN IF EXISTS last_outcome,
  DROP COLUMN IF EXISTS last_attempted_at,
  DROP COLUMN IF EXISTS last_expected_units,
  DROP COLUMN IF EXISTS last_failed_units;
