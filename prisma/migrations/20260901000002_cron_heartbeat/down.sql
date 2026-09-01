-- Rollback for 20260901000002_cron_heartbeat.
--
-- Safe at any time. /api/health/ops reports a null heartbeat for an absent
-- row, and the monitor reads null as "this deployment predates the metric"
-- rather than as a failure, so dropping the table degrades to the previous
-- behaviour instead of turning a check red.
DROP TABLE IF EXISTS public.cron_heartbeat;
