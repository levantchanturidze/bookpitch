import { describe, it, expect } from 'vitest';
import { MIN_REMINDER_LEAD_HOURS } from '@/lib/messaging/reminder-window';
import { HEARTBEAT_JOBS } from '@/lib/cron-heartbeat-jobs';
import {
  evaluateOpsMetrics,
  DEFAULTS,
  OPS_DERIVED_CHECK_IDS,
} from '../scripts/production-monitor.mjs';

// -----------------------------------------------------------------------------
// §4.3 — does the scheduler actually meet the reminder SLA?
//
// The measurement, taken on 2026-09-01 from scheduled events only (manual
// dispatches excluded, which is the whole point of the cron-event split):
//
//   00:05  00:27  05:07  06:07  06:24  07:49  10:05  12:26  14:52  17:13  18:08
//
// Largest gap 4h40m, against a declared 15-minute schedule. GitHub does not
// guarantee scheduled delivery and this account routinely sees hours (R-08).
//
// The conclusion is NOT "replace the scheduler". The reminder window is a
// sliding [now, now + reminderLeadHours], recomputed every tick, so what
// matters is whether a tick lands inside the lead time — not whether it lands
// on the declared cadence. At the default 24h lead, a 4h40m worst case has
// roughly five times the margin it needs, and every organization in production
// is on that default.
//
// What was actually broken is the other end. `saveLeadHoursAction` accepted a
// lead time as low as ONE HOUR. Below the scheduler's worst-case gap, the
// sliding window steps straight over an appointment: it is not reminded late,
// it is never reminded, with no error, no log line and nothing that could
// observe it. One owner changing a number in the UI was enough to arm it.
//
// Two fixes, tested here:
//   * a floor on the lead time, derived from the measured worst case;
//   * an application-side heartbeat, so "GitHub queued a workflow" and "the
//     application did the work" stop being the same claim.
// -----------------------------------------------------------------------------

describe('the reminder lead time cannot be set below what the scheduler can honour', () => {
  // The worst gap actually observed between consecutive SCHEDULED deliveries.
  const MEASURED_WORST_GAP_HOURS = 4 + 40 / 60;

  it('the floor clears the measured worst-case delivery gap', () => {
    expect(MIN_REMINDER_LEAD_HOURS).toBeGreaterThan(MEASURED_WORST_GAP_HOURS);
  });

  it('the floor leaves the 24h default comfortably legal', () => {
    // Raising the floor must not invalidate what production is already using.
    expect(MIN_REMINDER_LEAD_HOURS).toBeLessThanOrEqual(24);
  });

  it('THE REGRESSION: a 1-hour lead is shorter than the scheduler can deliver', () => {
    // The value the UI used to accept. A tick would have to arrive within an
    // hour; the measured worst case is nearly five.
    expect(1).toBeLessThan(MEASURED_WORST_GAP_HOURS);
    expect(1).toBeLessThan(MIN_REMINDER_LEAD_HOURS);
  });

  it('the validator enforces the floor, not just the old 1-hour bound', () => {
    // Reads the action rather than importing it: saveLeadHoursAction is a
    // server action that opens a session and a transaction, and the property
    // under test is the bound it compares against.
    const src = readAction();
    expect(src).toMatch(/hours < MIN_REMINDER_LEAD_HOURS/);
    expect(src, 'the old 1-hour bound is still in force').not.toMatch(/hours < 1\b/);
  });

  it('the error explains that reminders would be SKIPPED, not delayed', () => {
    // An operator told "must be at least 8" will reasonably assume the old
    // behaviour still works and is merely discouraged.
    const src = readAction();
    expect(src).toMatch(/silently skipped rather than merely late/);
  });
});

function readAction(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  return readFileSync(
    path.resolve(__dirname, '..', 'components', 'reminders', 'actions.ts'),
    'utf8',
  );
}

// -----------------------------------------------------------------------------
// The heartbeat: invocation and completion are different claims.
// -----------------------------------------------------------------------------
describe('the monitor can tell a queued workflow from work actually done', () => {
  const check = (cronHeartbeat: Record<string, number | null>) =>
    evaluateOpsMetrics({ config: {}, cronHeartbeat }).find(
      (r: { id: string }) => r.id === 'cron-heartbeat-stale',
    );

  it('a recent completion passes and says how much work it did', () => {
    const r = check({ remindersMinutesAgo: 20, remindersLastUnits: 6 });
    expect(r!.ok).toBe(true);
    expect(r!.detail).toMatch(/handling 6 organization/);
  });

  it('THE CASE NOTHING COULD SEE: schedule arriving, endpoint doing nothing', () => {
    // cron-staleness is green here — GitHub delivered, curl exited 0 — and the
    // application has not completed a tick in nine hours.
    const r = check({ remindersMinutesAgo: 9 * 60, remindersLastUnits: 0 });
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/last completed 9\.0h ago/);
  });

  it('never having completed is a failure, not a fresh-deployment excuse', () => {
    const r = check({ remindersMinutesAgo: null, remindersLastUnits: null });
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/has never recorded a completion/);
    expect(r!.detail).toMatch(/whatever the workflow run list says/);
  });

  it('a deployment predating the heartbeat emits no check rather than a green one', () => {
    const results = evaluateOpsMetrics({ config: {} });
    expect(results.find((r: { id: string }) => r.id === 'cron-heartbeat-stale')).toBeUndefined();
  });

  it('the heartbeat limit is looser than the schedule-delivery limit', () => {
    // Otherwise it would just restate the same delivery complaint in a second
    // colour, and go red every time GitHub was late while the app was fine.
    expect(DEFAULTS.reminderHeartbeatMaxMinutes).toBeGreaterThan(DEFAULTS.cronMaxAgeMinutes);
    // …and it must still clear the measured worst-case delivery gap.
    expect(DEFAULTS.reminderHeartbeatMaxMinutes).toBeGreaterThan(4.7 * 60);
  });

  it('is registered, so monitor blindness cannot close its incident', () => {
    expect(OPS_DERIVED_CHECK_IDS).toContain('cron-heartbeat-stale');
  });

  it('every job that can be scheduled writes a heartbeat', () => {
    // db-partitions is deliberately absent: it is monthly, and
    // partition-maintenance already proves its effect directly by checking the
    // partitions exist. A heartbeat would be a second, weaker signal.
    expect([...HEARTBEAT_JOBS].sort()).toEqual([
      'audit-digest',
      'housekeeping',
      'reminders',
      'retention',
    ]);
  });
});
