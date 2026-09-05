import { describe, it, expect } from 'vitest';
import {
  evaluateSoak,
  SOAK_HEALTH_GATES,
  SOAK_PROGRESS_GATES,
} from '../scripts/soak-controller.mjs';
import { evaluateCronHealth } from '../scripts/production-monitor.mjs';
import { resolveRun, normaliseRun, isJudgeable } from '../scripts/run-evidence.mjs';

// -----------------------------------------------------------------------------
// §3 — an unreadable first attempt vanished instead of blocking.
//
// `resolveRun()` does the right thing: when `/actions/runs/{id}/attempts/1`
// cannot be read it KEEPS the record and marks it `unresolved: true`, because a
// record that disappears is indistinguishable from one that never failed.
//
// But it keeps the LATEST attempt's number on it — 2, or more — and
// `isNaturalObservation()` required attempt 1. So both consumers filtered the
// record straight back out. The fix protected the record and then the predicate
// discarded it one line later.
//
// Reproduced through evaluateSoak() before the fix: with enough clean
// observations either side, an unreadable in-window first attempt returned
//
//     status: 'success'
//
// while retrieving that SAME attempt as a failure returned 'awaiting-recovery'.
// Reading the outcome decided the verdict; failing to read it decided the
// verdict too, in the opposite direction, and in the direction that ships.
//
// The rule: unknown blocks. It is not a success — nothing was observed to
// succeed. It is not a failure either — nothing was observed to fail, so it
// must not restart a window over what may be a transient GitHub error.
//
// These tests drive the FINAL CONSUMERS and assert the verdict and the window,
// not helper return values.
// -----------------------------------------------------------------------------

const SHA = 'a'.repeat(40);
const START = '2026-09-01T00:00:00Z';
const NOW = new Date('2026-09-02T01:00:00Z'); // 25h after START

const state = (over: Record<string, unknown> = {}) => ({
  releaseSha: SHA,
  deploymentId: '6221617929',
  startedAt: START,
  effectiveWindowStart: START,
  restarts: [],
  ...over,
});

const DEPLOYMENT = {
  sha: SHA,
  id: '6221617929',
  state: 'success',
  environment: 'Production',
  aliasReleases: { 'bookpitch.ge': SHA, 'www.bookpitch.ge': SHA },
};

const at = (hoursAfterStart: number) =>
  new Date(new Date(START).getTime() + hoursAfterStart * 3_600_000).toISOString();

const run = (runId: number, hoursAfterStart: number, over: Record<string, unknown> = {}) => ({
  runId,
  event: 'schedule',
  conclusion: 'success',
  status: 'completed',
  runAttempt: 1,
  scheduledAtIsExact: true,
  completedAt: at(hoursAfterStart),
  unresolved: false,
  ...over,
});

/** The record `resolveRun` produces when attempt 1 cannot be read. */
const unreadable = (runId: number, hoursAfterStart: number) =>
  run(runId, hoursAfterStart, { runAttempt: 2, conclusion: null, unresolved: true });

/** A window with plenty of clean evidence — enough to carry a gate on its own. */
function healthyEvidence(over: Record<string, unknown> = {}) {
  return {
    monitorRuns: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => run(100 + n, n * 3)),
    backupRuns: [run(200, 6)],
    cronRuns: [run(300, 2), run(301, 8), run(302, 14), run(303, 20), run(304, 23)],
    incidents: [],
    deployment: DEPLOYMENT,
    historyComplete: true,
    sentry: {
      configured: true,
      ok: true,
      serverEventId: 'srv-abc',
      browserEventId: 'brw-def',
      problems: [],
      verifiedAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
    },
    outboxDead: 0,
    unhealthyJobs: [],
    retentionSuccessAt: new Date(NOW.getTime() - 13 * 3_600_000).toISOString(),
    ...over,
  };
}

const gate = (r: { gates: Array<{ id: string; ok: boolean; detail: string }> }, id: string) =>
  r.gates.find((g) => g.id === id)!;

// =============================================================================
// SOAK — the final verdict
// =============================================================================
describe('the soak cannot certify a window containing an unknown outcome', () => {
  it('the baseline really does succeed, or nothing below means anything', () => {
    const r = evaluateSoak({ state: state(), evidence: healthyEvidence(), now: NOW });
    expect(r.status).toBe('success');
  });

  it('THE DEFECT: an unreadable in-window monitor attempt blocks success', () => {
    // Eight clean observations surround it. Before the fix the unreadable
    // record was filtered out by `isNaturalObservation` and these eight carried
    // every gate to SOAK SUCCESS.
    const evidence = healthyEvidence({
      monitorRuns: [
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => run(100 + n, n * 3)),
        unreadable(150, 12),
      ],
    });
    const r = evaluateSoak({ state: state(), evidence, now: NOW });
    expect(r.status, 'unknown is not success').not.toBe('success');
    expect(gate(r, 'evidence-resolved').ok).toBe(false);
    expect(gate(r, 'evidence-resolved').detail).toContain('150');
  });

  it('THE DEFECT: the same record retrieved as a FAILURE restarts the window', () => {
    // The asymmetry that made the defect dangerous: this branch always worked.
    const evidence = healthyEvidence({
      monitorRuns: [
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => run(100 + n, n * 3)),
        run(150, 12, { conclusion: 'failure' }),
      ],
    });
    const r = evaluateSoak({ state: state(), evidence, now: NOW });
    expect(r.status).not.toBe('success');
    expect(r.restarts.length).toBeGreaterThan(0);
  });

  it('an unknown does NOT restart the window — a read error is not a failure', () => {
    // Deliberate asymmetry with the test above. Restarting here would discard a
    // day of real evidence because GitHub returned a 500, and would livelock at
    // awaiting-recovery if the attempt stayed unreadable.
    const evidence = healthyEvidence({
      monitorRuns: [
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => run(100 + n, n * 3)),
        unreadable(150, 12),
      ],
    });
    const r = evaluateSoak({ state: state(), evidence, now: NOW });
    expect(r.status).toBe('running');
    expect(r.restartedThisTick).toBeNull();
    expect(r.awaitingRecoverySince).toBeNull();
    expect(
      new Date(r.effectiveWindowStart).getTime(),
      'the window is preserved, not discarded',
    ).toBe(new Date(START).getTime());
  });

  it('an unreadable BACKUP attempt blocks, though the successful backup still counts', () => {
    const evidence = healthyEvidence({ backupRuns: [run(200, 6), unreadable(201, 9)] });
    const r = evaluateSoak({ state: state(), evidence, now: NOW });
    expect(gate(r, 'scheduled-backup').ok, 'the readable one is still a backup').toBe(true);
    expect(gate(r, 'evidence-resolved').ok).toBe(false);
    expect(r.status).not.toBe('success');
  });

  it('an unreadable CRON attempt blocks, though the quorum is otherwise met', () => {
    const evidence = healthyEvidence({
      cronRuns: [
        run(300, 2),
        run(301, 8),
        run(302, 14),
        run(303, 20),
        run(304, 23),
        unreadable(305, 11),
      ],
    });
    const r = evaluateSoak({ state: state(), evidence, now: NOW });
    expect(gate(r, 'scheduled-cron').ok).toBe(true);
    expect(gate(r, 'evidence-resolved').ok).toBe(false);
    expect(r.status).not.toBe('success');
  });

  it('an unknown is never counted as a clean observation', () => {
    const evidence = healthyEvidence({
      monitorRuns: [
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => run(100 + n, n * 3)),
        unreadable(150, 12),
      ],
    });
    const r = evaluateSoak({ state: state(), evidence, now: NOW });
    expect(r.evidenceIds.monitorRuns).not.toContain(150);
  });

  it('an unknown OUTSIDE the window does not block it', () => {
    // Boundary. The record is before the effective window start, so it is not
    // evidence about this window at all.
    const evidence = healthyEvidence({
      monitorRuns: [
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => run(100 + n, n * 3)),
        unreadable(150, -4),
      ],
    });
    const r = evaluateSoak({ state: state(), evidence, now: NOW });
    expect(gate(r, 'evidence-resolved').ok).toBe(true);
    expect(r.status).toBe('success');
  });

  it('an unknown before a RECOVERY boundary does not block the window after it', () => {
    // A failure at h6 restarts the window; recovery is the clean observation at
    // h9. An unknown at h7 is inside the discarded stretch, not the new window.
    const evidence = healthyEvidence({
      monitorRuns: [
        run(101, 3),
        run(102, 6, { conclusion: 'failure' }),
        unreadable(150, 7),
        ...[9, 12, 15, 18, 21, 24].map((h, i) => run(160 + i, h)),
      ],
      // Re-stated after the restart at h9 so the other gates stay satisfiable.
      backupRuns: [run(200, 12)],
      cronRuns: [run(300, 10), run(301, 14), run(302, 18), run(303, 22)],
      retentionSuccessAt: at(15),
    });
    const r = evaluateSoak({
      state: state({ awaitingRecoverySince: at(6), restarts: [{ at: at(6), reason: 'seeded' }] }),
      evidence,
      now: NOW,
    });
    expect(new Date(r.effectiveWindowStart).getTime(), 'window restarted at the h9 recovery').toBe(
      new Date(at(9)).getTime(),
    );
    expect(gate(r, 'evidence-resolved').ok, 'the unknown at h7 is behind the boundary').toBe(true);
  });

  it('the gate is registered as progress, not health, and exactly once', () => {
    // Health gates restart the window. This one must not, and the repository's
    // parity rule requires every emitted gate to be in exactly one list.
    expect(SOAK_PROGRESS_GATES).toContain('evidence-resolved');
    expect(SOAK_HEALTH_GATES).not.toContain('evidence-resolved');
    const r = evaluateSoak({ state: state(), evidence: healthyEvidence(), now: NOW });
    for (const g of r.gates) {
      const inHealth = SOAK_HEALTH_GATES.includes(g.id);
      const inProgress = SOAK_PROGRESS_GATES.includes(g.id);
      expect(inHealth !== inProgress, `${g.id} must be in exactly one list`).toBe(true);
    }
  });

  it('incomplete history still blocks independently of the unknown', () => {
    const evidence = healthyEvidence({
      historyComplete: false,
      monitorRuns: [run(101, 3), run(102, 6), unreadable(150, 12)],
    });
    const r = evaluateSoak({ state: state(), evidence, now: NOW });
    expect(gate(r, 'history-continuity').ok).toBe(false);
    expect(gate(r, 'evidence-resolved').ok).toBe(false);
    expect(r.status).not.toBe('success');
  });

  it('COMPLEMENT: once the attempt becomes readable and SUCCEEDED, the soak certifies', () => {
    // The gate must be able to go green, or it is a livelock rather than a
    // check. Same window, same run id, attempt 1 now retrievable.
    const evidence = healthyEvidence({
      monitorRuns: [...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => run(100 + n, n * 3)), run(150, 12)],
    });
    const r = evaluateSoak({ state: state(), evidence, now: NOW });
    expect(gate(r, 'evidence-resolved').ok).toBe(true);
    expect(r.status).toBe('success');
  });
});

// =============================================================================
// MONITOR — the final check list
// =============================================================================
describe('the monitor reports an unknown cron outcome instead of dropping it', () => {
  const NOW_M = new Date('2026-09-02T01:00:00Z');
  const cron = (runId: number, minutesAgo: number, over: Record<string, unknown> = {}) => ({
    runId,
    event: 'schedule',
    status: 'completed',
    conclusion: 'success',
    runAttempt: 1,
    scheduledAtIsExact: true,
    completedAt: new Date(NOW_M.getTime() - minutesAgo * 60_000).toISOString(),
    unresolved: false,
    ...over,
  });
  const unreadableCron = (runId: number, minutesAgo: number) =>
    cron(runId, minutesAgo, { runAttempt: 2, conclusion: null, unresolved: true });

  const find = (rs: Array<{ id: string }>, id: string) =>
    rs.find((r) => r.id === id)! as {
      id: string;
      ok: boolean;
      detail: string;
      informational?: boolean;
    };

  it('a clean history passes the new gate', () => {
    const results = evaluateCronHealth([cron(1, 10), cron(2, 40), cron(3, 70)], NOW_M);
    expect(find(results, 'cron-evidence-unresolved').ok).toBe(true);
  });

  it('THE DEFECT: an unreadable first attempt FAILS a gating check', () => {
    const results = evaluateCronHealth([cron(1, 10), unreadableCron(2, 40), cron(3, 70)], NOW_M);
    const g = find(results, 'cron-evidence-unresolved');
    expect(g.ok).toBe(false);
    expect(g.informational, 'it must gate the run, not merely narrate').toBeUndefined();
    expect(g.detail).toContain('2');
  });

  it('THE DEFECT: an unknown is not counted as a cron success', () => {
    // Every run unreadable: staleness must not find a natural success.
    const results = evaluateCronHealth([unreadableCron(1, 10), unreadableCron(2, 40)], NOW_M);
    expect(find(results, 'cron-staleness').ok).toBe(false);
    expect(find(results, 'cron-evidence-unresolved').ok).toBe(false);
  });

  it('an unknown as the most recent scheduled run does not crash the staleness detail', () => {
    // `latest.conclusion.toUpperCase()` on a null conclusion threw here.
    const results = evaluateCronHealth([unreadableCron(1, 6000), cron(2, 6100)], NOW_M);
    const s = find(results, 'cron-staleness');
    expect(s.ok).toBe(false);
    expect(s.detail).toMatch(/UNKNOWN/);
  });

  it('a re-run whose LATEST attempt is still running is not discarded', () => {
    // The record carries the latest attempt's `in_progress` status. Filtering on
    // completion dropped it — so starting a re-run and not waiting for it was
    // enough to hide the original failure.
    const stillRunning = cron(9, 30, {
      runAttempt: 2,
      status: 'in_progress',
      conclusion: null,
      unresolved: true,
    });
    const results = evaluateCronHealth([cron(1, 10), stillRunning, cron(3, 70)], NOW_M);
    expect(find(results, 'cron-evidence-unresolved').ok).toBe(false);
    expect(find(results, 'cron-evidence-unresolved').detail).toContain('9');
  });

  it('COMPLEMENT: an ordinary in-progress FIRST attempt is still just pending', () => {
    // Not the same thing at all. Attempt 1 running means the run has not
    // finished; there is no earlier outcome being hidden.
    const pending = cron(9, 5, { status: 'in_progress', conclusion: null });
    const results = evaluateCronHealth([pending, cron(1, 10), cron(2, 40)], NOW_M);
    expect(find(results, 'cron-evidence-unresolved').ok, 'nothing is unreadable').toBe(true);
    expect(find(results, 'cron-staleness').ok, 'the completed runs still count').toBe(true);
  });
});

// =============================================================================
// The resolution step itself, on the shapes GitHub actually returns
// =============================================================================
describe('malformed and wrong-attempt responses fail closed', () => {
  const latest = () => ({
    id: 500,
    event: 'schedule',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 2,
    created_at: '2026-09-01T12:00:00Z',
    updated_at: '2026-09-01T20:00:00Z',
  });

  it('a response for the WRONG attempt is treated as unreadable', async () => {
    const r = await resolveRun(latest(), async () => ({ ...latest(), run_attempt: 3 }));
    expect(r.unresolved).toBe(true);
    expect(r.conclusion).toBeNull();
  });

  it('a malformed response — no attempt number at all — is unreadable', async () => {
    const r = await resolveRun(latest(), async () => ({ ...latest(), run_attempt: undefined }));
    expect(r.unresolved).toBe(true);
  });

  it('an empty object is unreadable, not a success', async () => {
    const r = await resolveRun(latest(), async () => ({}));
    expect(r.unresolved).toBe(true);
    expect(r.conclusion).toBeNull();
  });

  it('an unresolved record is judgeable even while the re-run is in progress', () => {
    const running = { ...normaliseRun({ ...latest(), status: 'in_progress' }), unresolved: true };
    expect(isJudgeable(running), 'or it is dropped before any gate sees it').toBe(true);
  });

  it('COMPLEMENT: a genuinely pending first attempt is NOT judgeable yet', () => {
    const pending = normaliseRun({ ...latest(), run_attempt: 1, status: 'in_progress' });
    expect(isJudgeable(pending)).toBe(false);
  });
});
