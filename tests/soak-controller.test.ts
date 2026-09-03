import { describe, it, expect } from 'vitest';
import {
  nextSentryState,
  seedSentryState,
  SOAK_HEALTH_GATES,
  SOAK_PROGRESS_GATES,
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
      ok: true,
      serverEventId: 'srv-abc',
      browserEventId: 'brw-def',
      problems: [],
    },
    outboxDead: 0,
    unhealthyJobs: [],
    // The nightly sweep, inside the window. 12 hours ago against a window that
    // began 25 hours ago — see the `retention-in-window` gate for why "fresh"
    // is not the same question as "inside the window".
    retentionSuccessMinutesAgo: 13 * 60,
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
    // Two observations across 25 hours leaves holes far wider than the 5-hour
    // continuity limit, so this is also a stretch nobody was watching — which
    // is a health failure, not merely slow progress. Either way it is not
    // success, and the count gate is the one under test here.
    expect(r.status).not.toBe('success');
    expect(gate(r, 'monitor-observations').ok).toBe(false);
    expect(gate(r, 'monitor-observations').detail).toMatch(/need 6/);
  });

  it('few observations but no long gap is PROGRESS, not a health failure', () => {
    // The complement, and the reason `monitor-observations` is a progress gate
    // while `observation-gap` is a health gate: a young window legitimately has
    // few observations and must be allowed to keep accruing.
    const young = state({
      effectiveWindowStart: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
    });
    const r = evaluateSoak({
      state: young,
      evidence: healthyEvidence({
        monitorRuns: [
          {
            runId: 1,
            event: 'schedule',
            conclusion: 'success',
            completedAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
          },
          {
            runId: 2,
            event: 'schedule',
            conclusion: 'success',
            completedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
          },
        ],
        historyComplete: true,
      }),
      now: NOW,
    });
    expect(r.status).toBe('running');
    expect(gate(r, 'monitor-observations').ok).toBe(false);
    expect(gate(r, 'observation-gap').ok).toBe(true);
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
    // Awaiting recovery rather than `restarted`: incident #77 is still OPEN, so
    // production is unhealthy right now and there is nothing to restart into.
    // A window cannot begin while the thing that ended the last one is ongoing.
    expect(r.status).toBe('awaiting-recovery');
    expect(r.awaitingRecoverySince).toBeTruthy();
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
    // #78 opened inside the original window and closed, so the window restarts
    // at the first healthy observation after the closure. The gate then reads
    // the NEW window, which the incident precedes — the restart is the record
    // that it happened, not a permanently red gate.
    expect(r.status).toBe('restarted');
    expect(r.restartedThisTick).toBeTruthy();
    expect(r.restarts.some((x: { reason: string }) => /#78/.test(x.reason))).toBe(true);
    expect(new Date(r.windowStart).getTime()).toBeGreaterThan(
      new Date(START).getTime() + 10 * 3_600_000,
    );
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
        sentry: { configured: false, ok: false, serverEventId: null, browserEventId: null },
      }),
      now: NOW,
    });
    expect(r.status).not.toBe('success');
    expect(gate(r, 'observability').ok).toBe(false);
    expect(gate(r, 'observability').detail).toMatch(/uncaught exceptions are discarded/);
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
          ok: false,
          serverEventId: null,
          browserEventId: null,
          problems: ['need BOTH a server and a browser event id'],
        },
      }),
      now: NOW,
    });
    expect(gate(r, 'observability').ok).toBe(false);
    expect(gate(r, 'observability').detail).toMatch(/receipt not valid/);
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
    // Not `blocked`: an unreadable deployment record is a failed API call, not
    // a misconfigured soak. It must stop the clock without ending the soak —
    // a thirty-second GitHub outage should not be fatal to a 24-hour window.
    expect(r.status).toBe('awaiting-recovery');
    expect(r.summary).toMatch(/could not be read/);
  });

  it('a deployment that is not READY is refused', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ deployment: { ...DEPLOYMENT, state: 'failure' } }),
      now: NOW,
    });
    // A deployment whose STATUS is not success is production being unhealthy,
    // not production being a different release — so it can recover.
    expect(r.status).toBe('awaiting-recovery');
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
    // No header means no evidence, and no evidence is not a verdict about which
    // release is live. Transient, so the soak survives it.
    expect(r.status).toBe('awaiting-recovery');
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
    // `blocked`, not `superseded`: a soak with no pin was set up wrong, and
    // waiting cannot fix a setup error. Distinguishing the two is the point —
    // one needs a new soak, the other needs a person.
    expect(r.status).toBe('blocked');
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
          // No boolean can satisfy the gate any more; only a validated receipt.
          receiptVerified: true,
          ok: false,
          serverEventId: null,
          browserEventId: null,
          problems: ['no event was retrievable from Sentry'],
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
          ok: false,
          serverEventId: 'srv-abc',
          browserEventId: null,
          problems: ['browser: no event was retrievable from Sentry'],
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
          ok: false,
          serverEventId: 'srv-abc',
          browserEventId: 'brw-def',
          problems: ['no stack frame in either event resolved to original source'],
        },
      }),
      now: NOW,
    });
    expect(gate(r, 'observability').ok).toBe(false);
    expect(gate(r, 'observability').detail).toMatch(/resolved to original source/);
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

// -----------------------------------------------------------------------------
// The receipt must survive its own persistence.
//
// Two defects that together made a valid Sentry receipt self-destruct after one
// tick, found by the final false-green review:
//
//   * nextState.sentry did not carry the NONCE forward, and
//     verifySentryReceipt() requires it — so the very next tick reported "no
//     verified event ids and nonce are persisted";
//   * verifiedAt was rewritten to now() on every successful tick, and it is the
//     `notBefore` bound. Moving it forward makes the events — created once, at
//     probe time — "predate this verification run" and fail freshness.
//
// Either alone invalidates the observability gate on tick two, which under the
// corrected state machine puts the whole soak into awaiting-recovery. A soak
// that can never survive its second tick is not a soak.
// -----------------------------------------------------------------------------
describe('persisted Sentry receipt is immutable where it must be', () => {
  const receipt = {
    nonce: 'probe-nonce-abcdef123456',
    verifiedAt: '2026-09-03T10:00:00Z',
    releaseSha: SHA,
    environment: 'production',
    serverEventId: 'srv-abc',
    browserEventId: 'brw-def',
  };

  it('nextSentryState carries the nonce forward unchanged', () => {
    const next = nextSentryState(receipt, {
      configured: true,
      ok: true,
      serverEventId: 'srv-abc',
      browserEventId: 'brw-def',
    });
    expect(next.nonce, 'the nonce must survive the tick').toBe(receipt.nonce);
  });

  it('THE DEFECT: verifiedAt is never advanced by a later tick', () => {
    const next = nextSentryState(receipt, {
      configured: true,
      ok: true,
      serverEventId: 'srv-abc',
      browserEventId: 'brw-def',
    });
    expect(next.verifiedAt, 'verifiedAt is the notBefore bound and must not move').toBe(
      receipt.verifiedAt,
    );
  });

  it('release and environment are carried forward, not re-derived', () => {
    const next = nextSentryState(receipt, {
      configured: true,
      ok: true,
      serverEventId: 'srv-abc',
      browserEventId: 'brw-def',
    });
    expect(next.releaseSha).toBe(SHA);
    expect(next.environment).toBe('production');
  });

  it('a failed revalidation does not erase the receipt it was checking', () => {
    // Otherwise a transient Sentry API outage would destroy the evidence and
    // the soak could never recover without re-running the probe.
    const next = nextSentryState(receipt, {
      configured: true,
      ok: false,
      serverEventId: null,
      browserEventId: null,
      problems: ['Sentry API unreachable'],
    });
    expect(next.nonce).toBe(receipt.nonce);
    expect(next.verifiedAt).toBe(receipt.verifiedAt);
    expect(next.serverEventId).toBe('srv-abc');
    expect(next.browserEventId).toBe('brw-def');
  });

  it('with no prior receipt there is nothing to preserve', () => {
    const next = nextSentryState(null, { configured: false, ok: false });
    expect(next.nonce).toBeNull();
    expect(next.verifiedAt).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Defects found by the final false-green review: the receipt could never GET
// into soak state, and its freshness bound was computed from the wrong end of
// the verification run. Both fail closed — so instead of a false green they
// produced a soak that could never go green at all, which is the same amount of
// broken and harder to notice, because "⏳ observability" looks like patience.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('a verified receipt can be seeded into soak state automatically', () => {
  const receipt = {
    notBefore: '2026-09-03T09:00:00.000Z',
    verifiedAt: '2026-09-03T09:02:30.000Z',
    nonce: 'abcd1234abcd1234',
    releaseSha: 'f'.repeat(40),
    environment: 'production',
    serverEventId: 'srv-1',
    browserEventId: 'brw-2',
  };

  it('THE DEFECT: a receipt file becomes persisted sentry state', () => {
    // Without this there is no supported path at all: nextSentryState() reads
    // `persisted.nonce`, nothing ever wrote one, and the only way to produce it
    // would be hand-editing the soak issue body — which is exactly the manual
    // evidence the gate exists to replace.
    const seeded = seedSentryState(JSON.stringify(receipt));
    expect(seeded).not.toBeNull();
    expect(seeded!.nonce).toBe('abcd1234abcd1234');
    expect(seeded!.serverEventId).toBe('srv-1');
    expect(seeded!.browserEventId).toBe('brw-2');
    expect(seeded!.releaseSha).toBe('f'.repeat(40));
  });

  it('THE DEFECT: the freshness bound is the START of the run, not the end', () => {
    // The probe fires, THEN the receipt is written. Using the write time as
    // `notBefore` means the events it just proved "predate this verification
    // run" on the very next tick.
    const seeded = seedSentryState(JSON.stringify(receipt));
    expect(new Date(seeded!.verifiedAt!).getTime()).toBe(Date.parse('2026-09-03T09:00:00.000Z'));
  });

  it('survives a tick: the seeded identity is carried forward unchanged', () => {
    const seeded = seedSentryState(JSON.stringify(receipt))!;
    const after = nextSentryState(seeded, {
      configured: true,
      ok: true,
      serverEventId: 'srv-1',
      browserEventId: 'brw-2',
      problems: [],
    });
    expect(after.nonce).toBe(seeded.nonce);
    expect(after.verifiedAt).toBe(seeded.verifiedAt);
    expect(after.releaseSha).toBe(seeded.releaseSha);
  });

  it('an incomplete receipt is refused rather than half-seeded', () => {
    for (const missing of ['nonce', 'serverEventId', 'browserEventId', 'releaseSha', 'notBefore']) {
      const partial: Record<string, unknown> = { ...receipt };
      delete partial[missing];
      expect(() => seedSentryState(JSON.stringify(partial)), missing).toThrow();
    }
  });

  it('the same event id for both runtimes is refused at seed time', () => {
    expect(() => seedSentryState(JSON.stringify({ ...receipt, browserEventId: 'srv-1' }))).toThrow(
      /same event/i,
    );
  });

  it('malformed JSON is refused, not silently ignored', () => {
    expect(() => seedSentryState('{not json')).toThrow();
  });

  it('no receipt at all yields null — absence is not a seeded receipt', () => {
    expect(seedSentryState(undefined)).toBeNull();
    expect(seedSentryState('')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// §4.3 — the daily jobs must run INSIDE the window, not merely look fresh.
//
// `cron-outcomes` asks whether each job's last success is within its contract
// limit. For retention that limit is 1800 minutes — 30 hours — because it runs
// nightly at 02:17 and GitHub's delivery is unreliable (R-08).
//
// 30 hours is longer than the soak window. So a retention success from 25 hours
// before the soak started satisfies `cron-outcomes` for the entire 24 hours,
// and the soak can certify a full window in which the nightly sweep never ran
// once. The whole reason the window is 24 hours rather than 2 is to cover the
// daily jobs; a 24-hour window that does not contain one is 24 hours of
// nothing.
//
// The evidence has to be an INSTANT compared against the effective window
// start, and it has to move when a recovery restarts the window.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('the daily sweep must land inside the effective window', () => {
  const NOW = new Date('2026-09-05T12:00:00Z');
  const startedAt = '2026-09-04T11:00:00Z';

  /** Healthy everything, so the retention gate is the only thing under test. */
  const evidence = (over: Record<string, unknown> = {}) => ({
    // Hourly for the whole 25-hour window: enough observations AND no gap
    // wider than the 5-hour limit. A fixture that satisfies the count but not
    // the spacing would leave this suite testing the wrong gate.
    monitorRuns: Array.from({ length: 25 }, (_, i) => ({
      runId: 100 + i,
      event: 'schedule',
      conclusion: 'success',
      completedAt: new Date(Date.parse(startedAt) + (i + 1) * 3_600_000).toISOString(),
    })),
    backupRuns: [
      {
        runId: 7,
        event: 'schedule',
        conclusion: 'success',
        completedAt: '2026-09-05T01:40:00Z',
      },
    ],
    cronRuns: Array.from({ length: 8 }, (_, i) => ({
      runId: 200 + i,
      event: 'schedule',
      conclusion: 'success',
      completedAt: new Date(Date.parse(startedAt) + (i + 1) * 5_400_000).toISOString(),
    })),
    incidents: [],
    deployment: {
      sha: 'a'.repeat(40),
      id: '555',
      state: 'success',
      environment: 'Production',
      // Which release each host is ACTUALLY serving, not a list of hosts that
      // answered 200 — see the DEPLOYMENT fixture above.
      aliasReleases: { 'bookpitch.ge': 'a'.repeat(40), 'www.bookpitch.ge': 'a'.repeat(40) },
    },
    sentry: { configured: true, ok: true, serverEventId: 's1', browserEventId: 'b1' },
    outboxDead: 0,
    unhealthyJobs: [],
    historyComplete: true,
    ...over,
  });

  const state = { releaseSha: 'a'.repeat(40), deploymentId: '555', startedAt, restarts: [] };
  const gate = (ev: Record<string, unknown>) =>
    evaluateSoak({ state, evidence: ev as never, now: NOW }).gates.find(
      (g: { id: string }) => g.id === 'retention-in-window',
    );

  it('THE DEFECT: a retention success from BEFORE the window does not count', () => {
    // 26 hours ago: inside retention's 30-hour freshness limit, and an hour
    // before the soak began. `cron-outcomes` is perfectly happy with it.
    const g = gate(evidence({ retentionSuccessMinutesAgo: 26 * 60 }));
    expect(g, 'there must be a gate for this at all').toBeDefined();
    expect(g!.ok, 'a sweep that ran before the window did not run in the window').toBe(false);
    expect(g!.detail).toMatch(/before the window/i);
  });

  it('a retention success inside the window counts', () => {
    // 10 hours ago, window started 25 hours ago.
    expect(gate(evidence({ retentionSuccessMinutesAgo: 10 * 60 }))!.ok).toBe(true);
  });

  it('unreadable retention evidence is not health', () => {
    for (const bad of [null, undefined, 'soon', NaN, -1]) {
      const g = gate(evidence({ retentionSuccessMinutesAgo: bad }));
      expect(g!.ok, `retentionSuccessMinutesAgo=${String(bad)}`).toBe(false);
    }
  });

  it('THE DEFECT: a restart moves the bar — evidence before the NEW start is stale', () => {
    // The window restarted 2 hours ago after a failure. A retention success
    // from 10 hours ago was inside the ORIGINAL window and is now outside the
    // effective one; crediting it would let a restart inherit the evidence the
    // restart exists to invalidate.
    const restarted = {
      ...state,
      effectiveWindowStart: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
    };
    const g = evaluateSoak({
      state: restarted,
      evidence: evidence({ retentionSuccessMinutesAgo: 10 * 60 }) as never,
      now: NOW,
    }).gates.find((x: { id: string }) => x.id === 'retention-in-window');
    expect(g!.ok).toBe(false);
  });

  it('the gate is one of the gates that must all pass for success', () => {
    const result = evaluateSoak({
      state,
      evidence: evidence({ retentionSuccessMinutesAgo: 26 * 60 }) as never,
      now: NOW,
    });
    expect(result.status).not.toBe('success');
    expect(result.summary).toMatch(/retention-in-window/);
  });

  it('COMPLEMENT: with retention inside the window everything else still passes', () => {
    // Otherwise this suite would prove only that something fails.
    const result = evaluateSoak({
      state,
      evidence: evidence({ retentionSuccessMinutesAgo: 10 * 60 }) as never,
      now: NOW,
    });
    const failing = result.gates.filter((g: { ok: boolean }) => !g.ok).map((g) => g.id);
    expect(failing).toEqual([]);
    expect(result.status).toBe('success');
  });
});

// -----------------------------------------------------------------------------
// §4.1 — one documented rule for what invalidates a window, and a correct
// four-way split between the states a tick can be in.
//
// Two defects, opposite in direction.
//
// UNHEALTHY TIME STAYED CREDITED. Only three things fed the recovery state:
// failed scheduled monitor/backup/cron runs, and in-window incidents. Every
// other release-critical gate — Sentry receipt revalidation, outbox dead
// letters, unhealthy required jobs, unreadable evidence — failed the tick and
// left the window untouched. So a Sentry outage at hour 23 produced one failing
// tick, and hour 24 reported SOAK SUCCESS on a window that contained a
// release-blocking failure. "Uninterrupted" was measured only against the three
// signals that happened to be wired.
//
// TRANSIENT UNREADABILITY WAS TERMINAL. Every identity problem returned
// `superseded`, including "canonical alias evidence could not be read". One
// failed HTTPS request while reading a release header permanently ended the
// soak with "the deployment under soak is not the one serving production" —
// a statement that was not true, about a condition that would have cleared
// itself in thirty seconds.
//
// The four states a tick must distinguish:
//
//   blocked            the soak was set up wrong. Waiting cannot fix it.
//   superseded         a DIFFERENT release is serving. Terminal, and correct.
//   awaiting-recovery  production is unhealthy, or its health cannot be read.
//                      No time accrues; the window restarts at the next fully
//                      healthy natural observation.
//   running / success  progress.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('every release-critical failure resets the window', () => {
  const near = () => state({ effectiveWindowStart: hoursBeforeEnd(23.5) });

  // A window 23.5 hours in, with everything healthy — one tick short of
  // success. Each case below spoils exactly one thing and must NOT be able to
  // reach success on the following tick.
  function hoursBeforeEnd(h: number) {
    return new Date(NOW.getTime() - h * 3_600_000).toISOString();
  }

  const cases: Array<[string, Record<string, unknown>]> = [
    [
      'Sentry receipt revalidation fails',
      { sentry: { configured: true, ok: false, problems: ['x'] } },
    ],
    ['Sentry API cannot be reached at all', { sentry: null }],
    ['production has no Sentry DSN', { sentry: { configured: false, ok: false } }],
    ['the outbox has dead letters', { outboxDead: 3 }],
    ['the outbox count cannot be read', { outboxDead: null }],
    ['a required job is unhealthy', { unhealthyJobs: ['retention'] }],
    ['the heartbeat map cannot be read', { unhealthyJobs: null }],
  ];

  for (const [label, spoil] of cases) {
    it(`THE DEFECT: ${label} → awaiting-recovery, not a passing window`, () => {
      const result = evaluateSoak({
        state: near(),
        evidence: healthyEvidence(spoil),
        now: NOW,
      });
      expect(result.status, `${label} must not leave the window intact`).toBe('awaiting-recovery');
      expect(result.awaitingRecoverySince).toBeTruthy();
    });
  }

  it('THE DEFECT: a failure at hour 23 cannot be followed by success at hour 24', () => {
    // The controlled-clock case §4.1 asks for. Tick one is unhealthy; tick two
    // is perfectly healthy an hour later. Without a persisted recovery state
    // the second tick sees 24.5 elapsed hours and declares success on a window
    // that contained a release-blocking failure.
    const t1 = NOW;
    const first = evaluateSoak({
      state: state({ effectiveWindowStart: hoursBeforeEnd(23) }),
      evidence: healthyEvidence({ outboxDead: 5 }),
      now: t1,
    });
    expect(first.status).toBe('awaiting-recovery');

    // One hour later, everything healthy again — but no monitor observation has
    // arrived since the failure, so nothing has proven recovery.
    const t2 = new Date(t1.getTime() + 3_600_000);
    const second = evaluateSoak({
      state: {
        ...state({ effectiveWindowStart: hoursBeforeEnd(23) }),
        awaitingRecoverySince: first.awaitingRecoverySince,
      },
      evidence: healthyEvidence(),
      now: t2,
    });
    expect(second.status, 'a healthy tick is not a healthy OBSERVATION').toBe('awaiting-recovery');
    expect(second.elapsedHours, 'no time may accrue while awaiting recovery').toBeLessThan(25);
  });

  it('recovery requires a natural monitor observation strictly after the failure', () => {
    const failedAt = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const recovered = evaluateSoak({
      state: {
        ...state({ effectiveWindowStart: hoursBeforeEnd(23) }),
        awaitingRecoverySince: failedAt,
      },
      evidence: healthyEvidence({
        monitorRuns: [
          {
            runId: 9001,
            event: 'schedule',
            conclusion: 'success',
            completedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
          },
        ],
      }),
      now: NOW,
    });
    // The window restarts AT that observation, so it is now ~1 hour old.
    expect(recovered.status).not.toBe('awaiting-recovery');
    expect(recovered.elapsedHours).toBeLessThan(2);
  });

  it('COMPLEMENT: a fully healthy 24h window still succeeds', () => {
    // Without this, the rule above could simply be "never succeed".
    const result = evaluateSoak({
      state: state(),
      evidence: healthyEvidence(),
      now: NOW,
    });
    expect(result.status).toBe('success');
  });
});

describe('unreadable evidence is transient, a different release is terminal', () => {
  it('THE DEFECT: unreadable alias evidence is not "superseded"', () => {
    // One failed HTTPS request while reading a release header used to end the
    // soak permanently, with a message asserting something that was not true.
    const result = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ deployment: { ...DEPLOYMENT, aliasReleases: null } }),
      now: NOW,
    });
    expect(result.status).toBe('awaiting-recovery');
  });

  it('THE DEFECT: a missing deployment record is transient too', () => {
    const result = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ deployment: null }),
      now: NOW,
    });
    expect(result.status).toBe('awaiting-recovery');
  });

  it('an alias that reports no release at all is transient', () => {
    const result = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        deployment: { ...DEPLOYMENT, aliasReleases: { 'bookpitch.ge': SHA } },
      }),
      now: NOW,
    });
    expect(result.status).toBe('awaiting-recovery');
  });

  it('but an alias serving a DIFFERENT release is superseded, terminally', () => {
    const other = 'f'.repeat(40);
    const result = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        deployment: {
          ...DEPLOYMENT,
          aliasReleases: { 'bookpitch.ge': other, 'www.bookpitch.ge': other },
        },
      }),
      now: NOW,
    });
    expect(result.status).toBe('superseded');
  });

  it('a different deployment id is superseded', () => {
    const result = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ deployment: { ...DEPLOYMENT, id: '999999' } }),
      now: NOW,
    });
    expect(result.status).toBe('superseded');
  });

  it('a soak started with no deployment pin is BLOCKED — waiting cannot fix setup', () => {
    const result = evaluateSoak({
      state: state({ deploymentId: null }),
      evidence: healthyEvidence(),
      now: NOW,
    });
    expect(result.status).toBe('blocked');
    expect(result.summary).toMatch(/pinned|set up|setup/i);
  });
});

describe('every gate is classified, so a new one cannot be silently neither', () => {
  it('each gate id is exactly one of health or progress', () => {
    const result = evaluateSoak({
      state: state(),
      evidence: healthyEvidence(),
      now: NOW,
    });
    const ids = result.gates.map((g: { id: string }) => g.id);
    const health = [...SOAK_HEALTH_GATES];
    const progress = [...SOAK_PROGRESS_GATES];
    for (const id of ids) {
      const inHealth = health.includes(id);
      const inProgress = progress.includes(id);
      expect(inHealth || inProgress, `${id} is classified as neither`).toBe(true);
      expect(inHealth && inProgress, `${id} is classified as both`).toBe(false);
    }
    // …and no classification names a gate that does not exist.
    for (const id of [...health, ...progress]) {
      expect(ids, `${id} is classified but never emitted`).toContain(id);
    }
  });
});
