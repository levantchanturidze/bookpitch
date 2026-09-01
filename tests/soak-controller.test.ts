import { describe, it, expect } from 'vitest';
import {
  evaluateSoak,
  parseState,
  renderState,
  renderReport,
  SOAK_DEFAULTS,
  SOAK_MARKER,
} from '../scripts/soak-controller.mjs';

// -----------------------------------------------------------------------------
// §13 — the durable soak controller.
//
// The soak has been "about to start" since Phase 15 and has never run once.
// The failure was always the same: it depended on a session staying alive for
// 24 hours. So the interesting tests here are not "does it add up the hours" —
// they are the ways a soak could report success without having proven anything:
//
//   * 24 hours elapsing while the monitor was failing;
//   * 24 hours elapsing with almost no observations, because GitHub dropped
//     the schedule (measured on this account: gaps of 4h40m — R-08);
//   * someone helping it along with manual dispatches, exactly as happened to
//     incident #38 on 2026-09-01;
//   * production being redeployed halfway through, so the second half
//     describes different code;
//   * a metric that could not be READ being counted as a metric that read
//     zero, which is how incident #26 was closed.
//
// Every one of those has a test below that must NOT report success.
// -----------------------------------------------------------------------------

const SHA = 'a'.repeat(40);
const START = '2026-09-01T00:00:00Z';
const NOW = new Date('2026-09-02T01:00:00Z'); // 25h after START

const state = (over: Record<string, unknown> = {}) => ({
  releaseSha: SHA,
  deploymentId: 'dpl_test',
  startedAt: START,
  restarts: [],
  ...over,
});

const run = (
  runId: number,
  hoursAfterStart: number,
  conclusion = 'success',
  event = 'schedule',
) => ({
  runId,
  event,
  conclusion,
  completedAt: new Date(new Date(START).getTime() + hoursAfterStart * 3_600_000).toISOString(),
});

/** A window in which every gate is satisfied. Each test spoils exactly one. */
function healthyEvidence(over: Record<string, unknown> = {}) {
  return {
    monitorRuns: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => run(100 + n, n * 3)),
    backupRuns: [run(200, 6)],
    cronRuns: [run(300, 2), run(301, 8), run(302, 14), run(303, 20), run(304, 23)],
    incidents: [],
    deployment: { sha: SHA, id: 'dpl_test' },
    sentry: { configured: true, receiptVerified: true },
    outboxDead: 0,
    ...over,
  };
}

const gate = (result: { gates: Array<{ id: string; ok: boolean; detail: string }> }, id: string) =>
  result.gates.find((g) => g.id === id)!;

describe('a healthy 24-hour window succeeds', () => {
  it('reports success with every gate satisfied', () => {
    const r = evaluateSoak({ state: state(), evidence: healthyEvidence(), now: NOW });
    expect(r.status).toBe('success');
    expect(r.gates.every((g) => g.ok)).toBe(true);
  });

  it('publishes the evidence ids rather than a bare verdict', () => {
    const r = evaluateSoak({ state: state(), evidence: healthyEvidence(), now: NOW });
    expect(r.evidenceIds.monitorRuns.length).toBeGreaterThanOrEqual(SOAK_DEFAULTS.minObservations);
    expect(r.evidenceIds.backupRuns).toContain(200);
    expect(r.evidenceIds.cronRuns).toContain(300);
    expect(renderReport(state(), r)).toMatch(/FINAL SUCCESS/);
  });
});

describe('time alone never satisfies the soak', () => {
  it('THE POINT: 25 hours with no observations is not a soak', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ monitorRuns: [] }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    expect(gate(r, 'window-elapsed').ok, 'the clock really has run out').toBe(true);
    expect(gate(r, 'monitor-observations').ok).toBe(false);
  });

  it('too few observations fails even though the window elapsed', () => {
    // GitHub dropping most of a 30-minute schedule is measured behaviour on
    // this account, and it must not be mistaken for a quiet, healthy day.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ monitorRuns: [run(1, 3), run(2, 9)] }),
      now: NOW,
    });
    expect(r.status).toBe('running');
    expect(gate(r, 'monitor-observations').ok).toBe(false);
    expect(gate(r, 'monitor-observations').detail).toMatch(/need 6/);
  });

  it('a window shorter than 24h is not yet a soak, however clean', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence(),
      now: new Date('2026-09-01T20:00:00Z'),
    });
    expect(r.status).toBe('running');
    expect(gate(r, 'window-elapsed').ok).toBe(false);
  });
});

describe('manual runs are not soak evidence', () => {
  it('THE REGRESSION: eight manual monitor runs prove nothing', () => {
    // Precisely what displaced the evidence that closed incident #38. A soak
    // is a claim about UNATTENDED operation, so a run someone started by hand
    // is the one thing that cannot support it.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        monitorRuns: [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
          run(400 + n, n * 3, 'success', 'workflow_dispatch'),
        ),
      }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    expect(gate(r, 'monitor-observations').ok).toBe(false);
    expect(gate(r, 'monitor-observations').detail).toMatch(/manual dispatches are not counted/);
  });

  it('manual cron runs do not satisfy the cron gate', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        cronRuns: [1, 2, 3, 4, 5].map((n) => run(500 + n, n * 4, 'success', 'workflow_dispatch')),
      }),
      now: NOW,
    });
    expect(gate(r, 'scheduled-cron').ok).toBe(false);
    expect(gate(r, 'scheduled-cron').detail).toMatch(/manual dispatches excluded/);
  });

  it('a manual backup does not satisfy the backup gate', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        backupRuns: [run(600, 5, 'success', 'workflow_dispatch')],
      }),
      now: NOW,
    });
    expect(gate(r, 'scheduled-backup').ok).toBe(false);
  });
});

describe('a release-critical failure restarts the window rather than being averaged away', () => {
  it('a failing observation resets the clock to the moment of failure', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        monitorRuns: [...healthyEvidence().monitorRuns, run(999, 20, 'failure')],
      }),
      now: NOW,
    });
    expect(r.status).toBe('restarted');
    expect(new Date(r.windowStart).toISOString()).toBe(
      new Date(new Date(START).getTime() + 20 * 3_600_000).toISOString(),
    );
    // …and the elapsed time is measured from there, not from the original start.
    expect(r.elapsedHours).toBeLessThan(SOAK_DEFAULTS.windowHours);
    expect(r.restarts).toHaveLength(1);
  });

  it('the observations before the failure do not carry forward', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        monitorRuns: [...healthyEvidence().monitorRuns, run(999, 23, 'failure')],
      }),
      now: NOW,
    });
    // The fixture has eight clean observations spread over 24 hours. After a
    // failure at hour 23 only the one at hour 24 is still inside the window —
    // the other seven describe a stretch that is no longer uninterrupted.
    expect(gate(r, 'monitor-observations').detail).toMatch(/^1 natural monitor observations/);
    expect(gate(r, 'monitor-observations').ok).toBe(false);
    expect(r.evidenceIds.monitorRuns).toEqual([108]);
  });

  it('an incident opened during the window restarts it too', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        incidents: [
          {
            number: 77,
            createdAt: new Date(new Date(START).getTime() + 10 * 3_600_000).toISOString(),
            state: 'open',
          },
        ],
      }),
      now: NOW,
    });
    expect(r.status).toBe('restarted');
    expect(gate(r, 'no-open-incident').ok).toBe(false);
    expect(gate(r, 'no-open-incident').detail).toMatch(/#77/);
  });

  it('an incident that was opened and CLOSED does not restart the window', () => {
    // Otherwise a soak could never complete on a repository where the monitor
    // opens and auto-closes anything.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        incidents: [
          {
            number: 78,
            createdAt: new Date(new Date(START).getTime() + 10 * 3_600_000).toISOString(),
            state: 'closed',
          },
        ],
      }),
      now: NOW,
    });
    expect(r.status).toBe('success');
  });

  it('an incident from BEFORE the window does not restart it', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        incidents: [{ number: 44, createdAt: '2026-08-30T00:00:00Z', state: 'open' }],
      }),
      now: NOW,
    });
    // A pre-existing open incident is a reason not to START a soak; it is not
    // a fresh failure inside this window.
    expect(r.status).toBe('success');
  });
});

describe('a soak measures exactly one deployment', () => {
  it('a redeploy mid-window ends the soak rather than silently continuing', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ deployment: { sha: 'b'.repeat(40), id: 'dpl_other' } }),
      now: NOW,
    });
    expect(r.status).toBe('superseded');
    expect(r.summary).toMatch(/A soak measures one deployment/);
    expect(renderReport(state(), r)).toMatch(/deployment it was measuring was replaced/);
  });
});

describe('unreadable is not healthy', () => {
  it('an outbox count that could not be read fails the gate', () => {
    // Incident #26 was closed because a check that could not run was read as a
    // check that passed. null must never mean zero.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ outboxDead: null }),
      now: NOW,
    });
    expect(gate(r, 'outbox-clean').ok).toBe(false);
    expect(gate(r, 'outbox-clean').detail).toMatch(/not evidence of health/);
  });

  it('dead-lettered rows fail the gate', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ outboxDead: 3 }),
      now: NOW,
    });
    expect(gate(r, 'outbox-clean').ok).toBe(false);
  });

  it('an unobserved window cannot succeed — Sentry unconfigured fails', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ sentry: { configured: false, receiptVerified: false } }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    expect(gate(r, 'observability').ok).toBe(false);
    expect(gate(r, 'observability').detail).toMatch(
      /uncaught exceptions in production are discarded/,
    );
  });

  it('Sentry configured but never RECEIPT-verified is not enough', () => {
    // A DSN that parses is not a DSN that delivers. scripts/verify-sentry.mjs
    // exists precisely because levels 1–3 pass against a project that does
    // not exist.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ sentry: { configured: true, receiptVerified: false } }),
      now: NOW,
    });
    expect(gate(r, 'observability').ok).toBe(false);
    expect(gate(r, 'observability').detail).toMatch(/receipt has not been verified/);
  });
});

describe('state survives the session that started it', () => {
  it('round-trips through an issue body', () => {
    const s = state({ restarts: [{ at: START, reason: 'because' }] });
    const body = renderState(s);
    expect(body).toContain(SOAK_MARKER);
    expect(parseState(body)).toEqual(s);
  });

  it('returns null for a body that carries no state, rather than inventing one', () => {
    expect(parseState('just an ordinary issue')).toBeNull();
    expect(parseState('')).toBeNull();
    expect(parseState(`${SOAK_MARKER}\n\n\`\`\`json\nnot json\n\`\`\``)).toBeNull();
  });
});
