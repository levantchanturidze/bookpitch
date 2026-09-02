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
  deploymentId: '6221617929',
  startedAt: START,
  effectiveWindowStart: START,
  restarts: [],
  ...over,
});

const DEPLOYMENT = {
  sha: SHA,
  // The GitHub Deployment record id — numeric in reality. The workflow input
  // used to be labelled "Vercel deployment id" while the controller compared
  // it with this, so a real Vercel id could never match and blank disabled the
  // check.
  id: '6221617929',
  state: 'success',
  environment: 'Production',
  // Which release each canonical host is ACTUALLY serving, read from the
  // x-bookpitch-release header after redirects. The previous shape was a list
  // of hosts that answered 200, which any deployment satisfies.
  aliasReleases: { 'bookpitch.ge': SHA, 'www.bookpitch.ge': SHA },
};

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
    deployment: DEPLOYMENT,
    historyComplete: true,
    sentry: {
      configured: true,
      serverEventId: 'srv-abc',
      browserEventId: 'brw-def',
      sourceMapsResolved: true,
    },
    outboxDead: 0,
    unhealthyJobs: [],
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
    expect(renderReport(state(), r)).toMatch(/SOAK SUCCESS/);
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
  it('a failing observation starts the clock at RECOVERY, not at the failure', () => {
    // The unhealthy stretch is discarded, not counted. Restarting at the
    // failure and immediately accruing time would count the hours during which
    // production was still broken toward the 24.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        monitorRuns: [...healthyEvidence().monitorRuns, run(999, 20, 'failure')],
      }),
      now: NOW,
    });
    expect(new Date(r.windowStart).toISOString()).toBe(
      new Date(new Date(START).getTime() + 21 * 3_600_000).toISOString(),
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
    // failure at hour 23 the window restarts at the hour-24 recovery run, so
    // nothing before it counts and the recovery run itself is the boundary.
    expect(gate(r, 'monitor-observations').detail).toMatch(/^0 natural monitor observations/);
    expect(gate(r, 'monitor-observations').ok).toBe(false);
    expect(r.evidenceIds.monitorRuns).toEqual([]);
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
    expect(gate(r, 'no-incident-in-window').ok).toBe(false);
    expect(gate(r, 'no-incident-in-window').detail).toMatch(/#77/);
  });

  it('THE REGRESSION: an incident opened and CLOSED during the window still restarts it', () => {
    // Previously ignored, because the filter required state === 'open'. An
    // incident that opened and auto-closed still means production was
    // unhealthy for part of the window, and the window is a claim about an
    // UNINTERRUPTED healthy stretch — not about how things ended up.
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
    expect(r.status).toBe('restarted');
    expect(gate(r, 'no-incident-in-window').ok).toBe(false);
  });

  it('an incident from BEFORE the window does not restart it', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        incidents: [{ number: 44, createdAt: '2026-08-30T00:00:00Z', state: 'open' }],
      }),
      now: NOW,
    });
    // It does not RESTART the window — it did not happen during it — but an
    // incident that is still open means production is unhealthy now, so the
    // window cannot be certified either.
    expect(r.status).not.toBe('success');
    expect(gate(r, 'no-incident-in-window').ok).toBe(false);
    expect(gate(r, 'no-incident-in-window').detail).toMatch(/currently open: #44/);
  });
});

describe('a soak measures exactly one deployment', () => {
  it('a redeploy mid-window ends the soak rather than silently continuing', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        deployment: {
          ...DEPLOYMENT,
          sha: 'b'.repeat(40),
          id: '9999999999',
          aliasReleases: { 'bookpitch.ge': 'b'.repeat(40), 'www.bookpitch.ge': 'b'.repeat(40) },
        },
      }),
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
      evidence: healthyEvidence({
        sentry: {
          configured: false,
          serverEventId: null,
          browserEventId: null,
          sourceMapsResolved: false,
        },
      }),
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
      evidence: healthyEvidence({
        sentry: {
          configured: true,
          serverEventId: null,
          browserEventId: null,
          sourceMapsResolved: false,
        },
      }),
      now: NOW,
    });
    expect(gate(r, 'observability').ok).toBe(false);
    expect(gate(r, 'observability').detail).toMatch(/need BOTH a server and a browser event id/);
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

// -----------------------------------------------------------------------------
// The defects found in the first soak controller.
//
// Each of these let the soak certify a window it had not actually held, which
// is the only failure mode that matters: a soak that can be fooled is worse
// than no soak, because it produces a document saying the release was watched.
// -----------------------------------------------------------------------------
describe('the window start is persisted, not re-derived', () => {
  it('THE REGRESSION: a restart survives the failing run ageing out of history', () => {
    // Tick 1: a failure at hour 20 resets the window to hour 20.
    const first = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        monitorRuns: [...healthyEvidence().monitorRuns, run(999, 20, 'failure')],
      }),
      now: NOW,
    });
    // A failure at hour 20, and the next healthy scheduled observation is the
    // fixture's hour-21 run. The window starts there.
    expect(first.effectiveWindowStart).toBe(
      new Date(new Date(START).getTime() + 21 * 3_600_000).toISOString(),
    );

    // Tick 2, a day later. The failing run is no longer in the fetched
    // history. Under the old controller windowStart was recomputed from
    // `startedAt`, so the restart evaporated and the soak claimed 49 hours it
    // had never held uninterrupted.
    const later = new Date(new Date(START).getTime() + 49 * 3_600_000);
    const second = evaluateSoak({
      state: state({
        effectiveWindowStart: first.effectiveWindowStart,
        awaitingRecoverySince: first.awaitingRecoverySince ?? null,
      }),
      evidence: healthyEvidence({
        monitorRuns: [21, 24, 27, 30, 33, 36, 39, 42].map((h) => run(700 + h, h)),
        backupRuns: [run(200, 30)],
        cronRuns: [25, 30, 35, 40].map((h) => run(300 + h, h)),
      }),
      now: later,
    });
    expect(second.effectiveWindowStart).toBe(first.effectiveWindowStart);
    // 49h since START, but only 28h since the recovery observation at hour 21 —
    // and that is what counts.
    expect(second.elapsedHours).toBeCloseTo(28, 0);
  });

  it('records the last processed monitor run so continuity is auditable', () => {
    const r = evaluateSoak({ state: state(), evidence: healthyEvidence(), now: NOW });
    expect(r.lastProcessedMonitorRun).toBe(108);
  });
});

describe('history must actually cover the window', () => {
  it('THE REGRESSION: a short page cannot certify a 24h window', () => {
    // The old controller fetched one page of 40. At one monitor run every 30
    // minutes a clean window holds ~48, so a failure in the first hours would
    // age out unseen and the remaining history would look spotless.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        historyComplete: false,
        // Newest 8 observations only; nothing reaching back to the start.
        monitorRuns: [17, 18, 19, 20, 21, 22, 23, 24].map((h) => run(800 + h, h)),
      }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    expect(gate(r, 'history-continuity').ok).toBe(false);
    expect(gate(r, 'history-continuity').detail).toMatch(/aged out unseen/);
  });

  it('history reaching back past the window start satisfies it', () => {
    expect(
      gate(
        evaluateSoak({ state: state(), evidence: healthyEvidence(), now: NOW }),
        'history-continuity',
      ).ok,
    ).toBe(true);
  });
});

describe('deployment evidence fails closed', () => {
  it('THE REGRESSION: a missing deployment blocks instead of skipping the check', () => {
    // Previously `if (evidence.deployment && …)` — a null simply skipped the
    // identity check, so the soak stopped knowing which code it measured while
    // a comment claimed a gate would catch it. No gate did.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ deployment: null }),
      now: NOW,
    });
    expect(r.status).toBe('blocked');
    expect(r.summary).toMatch(/cannot name the code it is measuring/);
  });

  it('a deployment that is not READY is refused', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ deployment: { ...DEPLOYMENT, state: 'failure' } }),
      now: NOW,
    });
    expect(r.status).toBe('superseded');
    expect(r.summary).toMatch(/state is failure/);
  });

  it('a deployment in the wrong environment is refused', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ deployment: { ...DEPLOYMENT, environment: 'Preview' } }),
      now: NOW,
    });
    expect(r.status).toBe('superseded');
    expect(r.summary).toMatch(/environment is Preview/);
  });

  it('a deployment id that is not the pinned one is refused', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ deployment: { ...DEPLOYMENT, id: '1234567890' } }),
      now: NOW,
    });
    expect(r.status).toBe('superseded');
    expect(r.summary).toMatch(/not the pinned 6221617929/);
  });

  it('THE REGRESSION: an alias serving a DIFFERENT release is refused', () => {
    // READY, newest, right SHA on the deployment record — and www is actually
    // serving something else. The previous check accepted any HTTP 200 and
    // ignored the expected SHA it was handed, so this passed.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        deployment: {
          ...DEPLOYMENT,
          aliasReleases: { 'bookpitch.ge': SHA, 'www.bookpitch.ge': 'c'.repeat(40) },
        },
      }),
      now: NOW,
    });
    expect(r.status).toBe('superseded');
    expect(r.summary).toMatch(/alias www\.bookpitch\.ge serves ccccccc/);
  });

  it('an alias that reports no release at all is refused', () => {
    // No header means no evidence, which must not read as agreement.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        deployment: {
          ...DEPLOYMENT,
          aliasReleases: { 'bookpitch.ge': SHA, 'www.bookpitch.ge': null },
        },
      }),
      now: NOW,
    });
    expect(r.status).toBe('superseded');
    expect(r.summary).toMatch(/alias www\.bookpitch\.ge did not report a release/);
  });

  it('THE REGRESSION: a missing pinned deployment id fails closed', () => {
    // The guards used to be `state.deploymentId && d.id && ...`, so leaving the
    // pin blank skipped the check it was meant to enforce.
    const r = evaluateSoak({
      state: state({ deploymentId: null }),
      evidence: healthyEvidence(),
      now: NOW,
    });
    expect(r.status).toBe('superseded');
    expect(r.summary).toMatch(/no deployment id was pinned/);
  });
});

describe('Sentry receipt is machine-verified, not asserted', () => {
  it('THE REGRESSION: there is no boolean that can satisfy the gate', () => {
    // The old gate read a workflow input an operator ticked. Event ids are the
    // only thing that passes now.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        sentry: {
          configured: true,
          receiptVerified: true,
          serverEventId: null,
          browserEventId: null,
          sourceMapsResolved: true,
        },
      }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    expect(gate(r, 'observability').ok).toBe(false);
  });

  it('both a server AND a browser event are required', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        sentry: {
          configured: true,
          serverEventId: 'srv-abc',
          browserEventId: null,
          sourceMapsResolved: true,
        },
      }),
      now: NOW,
    });
    expect(gate(r, 'observability').ok).toBe(false);
  });

  it('unresolved source maps fail even with both events received', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        sentry: {
          configured: true,
          serverEventId: 'srv-abc',
          browserEventId: 'brw-def',
          sourceMapsResolved: false,
        },
      }),
      now: NOW,
    });
    expect(gate(r, 'observability').ok).toBe(false);
    expect(gate(r, 'observability').detail).toMatch(/do not resolve through/);
  });
});

describe('cron outcomes gate the soak too', () => {
  it('a job whose last attempt failed blocks the window', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ unhealthyJobs: ['retention'] }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    expect(gate(r, 'cron-outcomes').ok).toBe(false);
  });

  it('an unreadable outcome is not health', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ unhealthyJobs: null }),
      now: NOW,
    });
    expect(gate(r, 'cron-outcomes').ok).toBe(false);
    expect(gate(r, 'cron-outcomes').detail).toMatch(/could not be read — not evidence of health/);
  });
});

describe('state corruption is refused rather than papered over', () => {
  it('a body carrying the marker but unreadable state yields null', () => {
    // main() exits non-zero on this rather than inventing a window start.
    expect(parseState(`${SOAK_MARKER}\n\n\`\`\`json\n{ oops\n\`\`\``)).toBeNull();
  });

  it('state missing effectiveWindowStart falls back to startedAt, not to now', () => {
    // An older state object must not be read as "the window starts now",
    // which would reset the clock on every upgrade.
    const r = evaluateSoak({
      state: { releaseSha: SHA, deploymentId: 'dpl_test', startedAt: START, restarts: [] },
      evidence: healthyEvidence(),
      now: NOW,
    });
    expect(r.effectiveWindowStart).toBe(new Date(START).toISOString());
  });
});

// -----------------------------------------------------------------------------
// §4 — written as an attacker would: how do I make an unhealthy window green?
//
// Each of these is a route to a soak that certifies time production was not
// actually healthy for. The previous controller conceded most of them.
// -----------------------------------------------------------------------------
describe('adversarial: routes to a falsely successful window', () => {
  it('a failed scheduled BACKUP inside the window invalidates it', () => {
    // The old controller restarted only for monitor failures and incidents, so
    // a failed backup sat inside the window while the backup gate passed on a
    // different, successful run.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        backupRuns: [run(201, 6, 'failure'), run(202, 12)],
      }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    expect(r.restarts.some((x: { reason: string }) => /backup run 201/.test(x.reason))).toBe(true);
  });

  it('a failed scheduled CRON inside the window invalidates it', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        cronRuns: [run(301, 4, 'failure'), run(302, 8), run(303, 14), run(304, 20), run(305, 23)],
      }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    expect(r.restarts.some((x: { reason: string }) => /cron run 301/.test(x.reason))).toBe(true);
  });

  it('THE POINT: the unhealthy recovery period is NOT counted as healthy time', () => {
    // Failure at hour 2; recovery not until hour 23. The old controller
    // restarted AT hour 2 and counted the 21 broken hours toward the 24.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        monitorRuns: [run(500, 2, 'failure'), run(501, 23), run(502, 24)],
      }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    // Window begins at the hour-23 recovery, so ~2h have elapsed, not ~23.
    expect(r.elapsedHours).toBeLessThan(3);
  });

  it('with no healthy observation after a failure, NO time accrues at all', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        monitorRuns: [...healthyEvidence().monitorRuns, run(999, 24, 'failure')],
      }),
      now: NOW,
    });
    expect(r.status).toBe('awaiting-recovery');
    expect(r.summary).toMatch(/no time is accruing/);
  });

  it('awaiting-recovery persists across ticks, so a quiet period cannot heal it', () => {
    // Tick 2 with the failing run no longer visible in history. Without
    // persisted awaitingRecoverySince the controller would see a clean window.
    const failedAt = new Date(new Date(START).getTime() + 24 * 3_600_000).toISOString();
    const r = evaluateSoak({
      state: state({ awaitingRecoverySince: failedAt }),
      evidence: healthyEvidence({ monitorRuns: [] }),
      now: new Date(new Date(START).getTime() + 60 * 3_600_000),
    });
    expect(r.status).toBe('awaiting-recovery');
  });

  it('a cancelled monitor run counts as unhealthy, not merely "not success"', () => {
    // `conclusion !== 'success'` on purpose: cancelled, timed_out and
    // action_required are all absences of evidence.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        monitorRuns: [...healthyEvidence().monitorRuns, run(998, 22, 'cancelled')],
      }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
  });

  it('six observations bunched at one end do not make a watched window', () => {
    // Count satisfied, continuity not: 20 hours unobserved in the middle.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        monitorRuns: [20, 21, 22, 23, 24, 25].map((h) => run(600 + h, h)),
      }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    expect(gate(r, 'observation-gap').ok).toBe(false);
    expect(gate(r, 'observation-gap').detail).toMatch(/largest gap/);
  });

  it('an incident opened AND closed inside the window still invalidates it', () => {
    // And recovery is required after the close, not after the open.
    const opened = new Date(new Date(START).getTime() + 10 * 3_600_000).toISOString();
    const closed = new Date(new Date(START).getTime() + 12 * 3_600_000).toISOString();
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        incidents: [{ number: 77, createdAt: opened, closedAt: closed, state: 'closed' }],
      }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    expect(
      r.restarts.some((x: { at: string }) => x.at === closed),
      'recovery must be required after the incident CLOSED, not when it opened',
    ).toBe(true);
  });

  it('a per-job heartbeat failure blocks the window', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ unhealthyJobs: ['retention'] }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    expect(gate(r, 'cron-outcomes').detail).toMatch(/retention/);
  });

  it('technical completion says SOAK SUCCESS, never FINAL SUCCESS', () => {
    // Overall final success additionally requires legal and mailbox/UAT
    // approval, which this controller cannot observe and must not imply.
    const r = evaluateSoak({ state: state(), evidence: healthyEvidence(), now: NOW });
    expect(r.status).toBe('success');
    const report = renderReport(state(), r);
    expect(report).toMatch(/SOAK SUCCESS/);
    expect(report).not.toMatch(/FINAL SUCCESS/);
  });
});
