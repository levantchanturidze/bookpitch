import { describe, it, expect } from 'vitest';
import {
  normaliseRun,
  isNaturalObservation,
  isNaturalSuccess,
  naturalEvidenceProblem,
} from '../scripts/run-evidence.mjs';

// -----------------------------------------------------------------------------
// §3 — `event === 'schedule'` is not enough to make a run natural evidence.
//
// Both the monitor and the soak filtered on the event alone. A workflow run
// KEEPS its `schedule` event when a human presses "Re-run failed jobs":
// GitHub increments `run_attempt`, replaces `conclusion`, and moves
// `updated_at`. The API returns the latest attempt by default.
//
// So the entire displaced-evidence defect that closed incident #38 was still
// available, just through a different button. A failed scheduled monitor run
// could be rerun into a success; the soak would see a clean window. A failed
// backup or cron run could be rerun; the count of natural successes would rise.
// And because `completedAt` came from `updated_at`, a rerun also moved the
// run's apparent time forward — past a recovery boundary the soak was ordering
// against.
//
// The rules, and they are deliberately strict:
//
//   natural       event === 'schedule' AND run_attempt === 1
//   ordering      by `created_at`, which a rerun does not change
//   attempt > 1   NOT a success, whatever it now says. Someone reran it, which
//                 means the authoritative first outcome is not what is being
//                 reported. Fails closed.
// -----------------------------------------------------------------------------

/** A GitHub API workflow-run object, trimmed to what is read. */
const apiRun = (over: Record<string, unknown> = {}) => ({
  id: 500,
  event: 'schedule',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  created_at: '2026-09-04T01:00:00Z',
  run_started_at: '2026-09-04T01:00:05Z',
  updated_at: '2026-09-04T01:02:00Z',
  ...over,
});

describe('a run is normalised with its attempt and its immutable time', () => {
  it('keeps the attempt number and separates scheduling from completion', () => {
    const r = normaliseRun(apiRun());
    expect(r.runAttempt).toBe(1);
    expect(r.scheduledAt).toBe('2026-09-04T01:00:00Z');
    expect(r.completedAt).toBe('2026-09-04T01:02:00Z');
  });

  it('a missing run_attempt is treated as a rerun, not as attempt 1', () => {
    // Fails closed: an API shape we do not recognise must not be promoted to
    // authoritative first-attempt evidence.
    expect(normaliseRun(apiRun({ run_attempt: undefined })).runAttempt).toBe(0);
    expect(isNaturalObservation(normaliseRun(apiRun({ run_attempt: undefined })))).toBe(false);
  });

  it('falls back to updated_at when created_at is absent, and says so', () => {
    const r = normaliseRun(apiRun({ created_at: undefined }));
    expect(r.scheduledAt).toBe('2026-09-04T01:02:00Z');
    expect(r.scheduledAtIsExact).toBe(false);
  });
});

describe('only a first-attempt scheduled run is natural evidence', () => {
  it('a first-attempt scheduled success is', () => {
    const r = normaliseRun(apiRun());
    expect(isNaturalObservation(r)).toBe(true);
    expect(isNaturalSuccess(r)).toBe(true);
    expect(naturalEvidenceProblem(r)).toBeNull();
  });

  it('THE DEFECT: a rerun scheduled run is not, however green it now looks', () => {
    const r = normaliseRun(apiRun({ run_attempt: 2, conclusion: 'success' }));
    expect(isNaturalObservation(r), 'a rerun is not unattended operation').toBe(false);
    expect(isNaturalSuccess(r)).toBe(false);
    expect(naturalEvidenceProblem(r)).toMatch(/attempt 2/);
  });

  it('THE DEFECT: rerunning a FAILED run cannot turn it into a success', () => {
    // The exact displaced-evidence move. The original attempt failed; a human
    // pressed re-run; the API now reports success on attempt 2.
    const r = normaliseRun(apiRun({ run_attempt: 2, conclusion: 'success' }));
    expect(isNaturalSuccess(r)).toBe(false);
  });

  it('a workflow_dispatch is not natural evidence even on attempt 1', () => {
    const r = normaliseRun(apiRun({ event: 'workflow_dispatch' }));
    expect(isNaturalObservation(r)).toBe(false);
    expect(naturalEvidenceProblem(r)).toMatch(/workflow_dispatch/);
  });

  it('an incomplete run is not evidence yet', () => {
    const r = normaliseRun(apiRun({ status: 'in_progress', conclusion: null }));
    expect(isNaturalSuccess(r)).toBe(false);
  });

  it('a genuinely failed first attempt is a natural OBSERVATION but not a success', () => {
    // It must stay visible: the soak needs to see the failure in order to
    // reset the window. Excluding it entirely is how a rerun would erase it.
    const r = normaliseRun(apiRun({ conclusion: 'failure' }));
    expect(isNaturalObservation(r)).toBe(true);
    expect(isNaturalSuccess(r)).toBe(false);
  });

  it('every non-success conclusion fails, including cancelled and timed_out', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', null]) {
      const r = normaliseRun(apiRun({ conclusion }));
      expect(isNaturalSuccess(r), String(conclusion)).toBe(false);
    }
  });
});

describe('ordering uses the time a rerun cannot move', () => {
  it('scheduledAt is unchanged by a rerun; completedAt is not', () => {
    const first = normaliseRun(apiRun());
    const rerun = normaliseRun(apiRun({ run_attempt: 2, updated_at: '2026-09-04T09:00:00Z' }));
    expect(rerun.scheduledAt).toBe(first.scheduledAt);
    expect(rerun.completedAt).not.toBe(first.completedAt);
  });
});
