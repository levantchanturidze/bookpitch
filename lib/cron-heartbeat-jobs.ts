// Leaf module: the job names, with no database import.
//
// The monitor and its tests need to know which jobs are expected to write a
// heartbeat; making that require lib/db (and transitively next-auth) would be
// a lot of machinery to read four strings.

/** Jobs that write a heartbeat. Keys are stable — the monitor reads them. */
export const HEARTBEAT_JOBS = ['reminders', 'housekeeping', 'retention', 'audit-digest'] as const;
export type HeartbeatJob = (typeof HEARTBEAT_JOBS)[number];
