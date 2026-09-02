// Leaf module: the job names, with no database import.
//
// The monitor and its tests need to know which jobs are expected to write a
// heartbeat; making that require lib/db (and transitively next-auth) would be
// a lot of machinery to read four strings.

/** Jobs that write a heartbeat. Keys are stable — the monitor reads them. */
export const HEARTBEAT_JOBS = ['reminders', 'housekeeping', 'retention', 'audit-digest'] as const;
export type HeartbeatJob = (typeof HEARTBEAT_JOBS)[number];

/**
 * How fresh each job's last SUCCESS must be, from its documented cadence in
 * .github/workflows/cron.yml plus slack for GitHub's measured delivery lag
 * (worst observed gap 4h40m against a declared 15 minutes — R-08).
 *
 * A job with no entry here is not required and is not evaluated. Every entry
 * is evaluated individually: the previous aggregate counted only rows that
 * already existed with a partial/failure outcome, so a job whose row was
 * MISSING, or still 'unknown', contributed nothing and the count read zero.
 * Four reminder runs proved nothing about retention, housekeeping or the
 * digest.
 */
export const HEARTBEAT_MAX_AGE_MINUTES: Readonly<Record<HeartbeatJob, number>> = {
  // every 15 min; 6h clears the measured worst-case delivery gap with margin
  reminders: 6 * 60,
  // hourly at :03
  housekeeping: 6 * 60,
  // nightly at 02:17 — a full day plus slack
  retention: 30 * 60,
  // rides the hourly schedule, but only does work when enabled
  'audit-digest': 30 * 60,
};

/**
 * Metric-response key for each job.
 *
 * The heartbeat row key is the job name as the workflow spells it
 * (`audit-digest`); the ops response uses camelCase like every other key in
 * that document. Not cosmetic: tests/ops-metrics.test.ts proves the response
 * carries no string values by stripping `"[a-zA-Z0-9]+":` and asserting no
 * letters survive, and a hyphenated key slips through that filter — so its
 * letters would read as a leaked value and the guard would have to be
 * loosened to accommodate it. Renaming the key keeps the guard exactly as
 * strict.
 */
export const HEARTBEAT_METRIC_KEY: Readonly<Record<HeartbeatJob, string>> = {
  reminders: 'reminders',
  housekeeping: 'housekeeping',
  retention: 'retention',
  'audit-digest': 'auditDigest',
};

/** Inverse of HEARTBEAT_METRIC_KEY, for reading the metric back. */
export const HEARTBEAT_JOB_FOR_METRIC_KEY: Readonly<Record<string, HeartbeatJob>> =
  Object.fromEntries(
    (Object.entries(HEARTBEAT_METRIC_KEY) as Array<[HeartbeatJob, string]>).map(([job, key]) => [
      key,
      job,
    ]),
  );
