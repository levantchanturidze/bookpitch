import { describe, it, expect, beforeEach } from 'vitest';
import {
  nextSentryState,
  seedSentryState,
  SOAK_HEALTH_GATES,
  SOAK_PROGRESS_GATES,
  soakFreshnessBound,
  soakStateDigest,
  SOAK_SEMANTIC_FIELDS,
  verifySoakState,
  SOAK_STATE_VERSION,
  SOAK_PRESENTATION_FIELDS,
  sentryProofAge,
  renderCheckpoint,
  parseCheckpoint,
  verifyCheckpointChain,
  verifyReverifyProvenance,
  reverifyProvenance,
  evaluateSoak,
  parseState,
  renderState,
  renderReport,
  SOAK_DEFAULTS,
  SOAK_MARKER,
} from '../scripts/soak-controller.mjs';
import { receiptDigest, verifyReceiptIntegrity } from '../scripts/sentry-receipt.mjs';

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

// runAttempt defaults to 1: these stand for runs the scheduler delivered and
// nobody touched. A re-run keeps the `schedule` event, so the attempt number is
// what distinguishes delivery from a button press — see the re-run suite below.
const run = (
  runId: number,
  hoursAfterStart: number,
  conclusion = 'success',
  event = 'schedule',
  runAttempt = 1,
) => ({
  runId,
  event,
  conclusion,
  status: 'completed',
  runAttempt,
  // Real runs carry an immutable created_at; `updated_at` moves when a run is
  // re-run, so a record without one is not natural evidence.
  scheduledAtIsExact: true,
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
      // The verifier's own signed completion time. Re-fetching the original
      // events proves only that they are still readable; this is the evidence
      // that new ones can still be ingested.
      verifiedAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
    },
    outboxDead: 0,
    unhealthyJobs: [],
    // The nightly sweep, inside the window. 12 hours ago against a window that
    // began 25 hours ago — see the `retention-in-window` gate for why "fresh"
    // is not the same question as "inside the window".
    retentionSuccessAt: new Date(new Date(NOW).getTime() - 13 * 3_600_000).toISOString(),
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
            runAttempt: 1,
            scheduledAtIsExact: true,

            status: 'completed',
            conclusion: 'success',
            completedAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
          },
          {
            runId: 2,
            event: 'schedule',
            runAttempt: 1,
            scheduledAtIsExact: true,

            status: 'completed',
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
    const earlier = new Date('2026-09-01T20:00:00Z');
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        // The shared fixture dates its proof relative to NOW; this test runs
        // five hours earlier, which would put the proof in the future and be
        // refused. Dated for this test's own clock instead.
        sentry: {
          configured: true,
          ok: true,
          serverEventId: 'srv-abc',
          browserEventId: 'brw-def',
          problems: [],
          verifiedAt: new Date(earlier.getTime() - 2 * 3_600_000).toISOString(),
        },
      }),
      now: earlier,
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
  // Signed the way scripts/verify-sentry.mjs signs it. CRON_SECRET is the key
  // both the verifier and the controller already hold; the receipt is stored in
  // a public issue body, so an unsigned one must never be seeded.
  const SECRET = 'seed-test-cron-secret';
  const signed = (over: Record<string, unknown> = {}) => {
    const r: Record<string, unknown> = {
      notBefore: '2026-09-03T09:00:00.000Z',
      verifiedAt: '2026-09-03T09:02:30.000Z',
      nonce: 'abcd1234abcd1234',
      releaseSha: 'f'.repeat(40),
      environment: 'production',
      serverEventId: 'srv-1',
      browserEventId: 'brw-2',
      serverSource: 'app/api/health/sentry-probe/route.ts',
      browserSource: 'app/probe/sentry/BrowserProbe.tsx',
      sourceMapsPublic: false,
      sourceMapAssets: '/_next/static/chunks/main.js',
      digest: '',
      ...over,
    };
    r.digest = receiptDigest(SECRET, r);
    return r;
  };
  const receipt = signed();

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });

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
    // The probe fires, THEN the receipt is written. A bound at the write time
    // makes the events it just proved "predate this verification run".
    //
    // This used to assert that seeding OVERWROTE `verifiedAt` with `notBefore`,
    // which produced the right bound and destroyed the signature — both fields
    // are signed. The bound is now derived, and both fields are preserved
    // exactly as the verifier emitted them.
    const seeded = seedSentryState(JSON.stringify(receipt))!;
    expect(soakFreshnessBound(seeded).getTime()).toBe(Date.parse('2026-09-03T09:00:00.000Z'));
    expect(seeded.notBefore, 'notBefore must survive verbatim').toBe(receipt.notBefore);
    expect(seeded.verifiedAt, 'verifiedAt must survive verbatim').toBe(receipt.verifiedAt);
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
    // Correctly signed, and still refused: one event cannot prove two SDKs.
    expect(() => seedSentryState(JSON.stringify(signed({ browserEventId: 'srv-1' })))).toThrow(
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
      runAttempt: 1,
      scheduledAtIsExact: true,

      status: 'completed',
      conclusion: 'success',
      completedAt: new Date(Date.parse(startedAt) + (i + 1) * 3_600_000).toISOString(),
    })),
    backupRuns: [
      {
        runId: 7,
        event: 'schedule',
        runAttempt: 1,
        scheduledAtIsExact: true,

        status: 'completed',
        conclusion: 'success',
        completedAt: '2026-09-05T01:40:00Z',
      },
    ],
    cronRuns: Array.from({ length: 8 }, (_, i) => ({
      runId: 200 + i,
      event: 'schedule',
      runAttempt: 1,
      scheduledAtIsExact: true,

      status: 'completed',
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
    sentry: {
      configured: true,
      ok: true,
      serverEventId: 's1',
      browserEventId: 'b1',
      verifiedAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
    },
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
    const g = gate(
      evidence({ retentionSuccessAt: new Date(NOW.getTime() - 26 * 3_600_000).toISOString() }),
    );
    expect(g, 'there must be a gate for this at all').toBeDefined();
    expect(g!.ok, 'a sweep that ran before the window did not run in the window').toBe(false);
    expect(g!.detail).toMatch(/before the window/i);
  });

  it('a retention success inside the window counts', () => {
    // 10 hours ago, window started 25 hours ago.
    expect(
      gate(
        evidence({ retentionSuccessAt: new Date(NOW.getTime() - 10 * 3_600_000).toISOString() }),
      )!.ok,
    ).toBe(true);
  });

  it('unreadable retention evidence is not health', () => {
    for (const bad of [null, undefined, 'soon', 'not-a-date', '']) {
      const g = gate(evidence({ retentionSuccessAt: bad }));
      expect(g!.ok, `retentionSuccessAt=${String(bad)}`).toBe(false);
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
      evidence: evidence({
        retentionSuccessAt: new Date(NOW.getTime() - 10 * 3_600_000).toISOString(),
      }) as never,
      now: NOW,
    }).gates.find((x: { id: string }) => x.id === 'retention-in-window');
    expect(g!.ok).toBe(false);
  });

  it('the gate is one of the gates that must all pass for success', () => {
    const result = evaluateSoak({
      state,
      evidence: evidence({
        retentionSuccessAt: new Date(NOW.getTime() - 26 * 3_600_000).toISOString(),
      }) as never,
      now: NOW,
    });
    expect(result.status).not.toBe('success');
    expect(result.summary).toMatch(/retention-in-window/);
  });

  it('COMPLEMENT: with retention inside the window everything else still passes', () => {
    // Otherwise this suite would prove only that something fails.
    const result = evaluateSoak({
      state,
      evidence: evidence({
        retentionSuccessAt: new Date(NOW.getTime() - 10 * 3_600_000).toISOString(),
      }) as never,
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
            runAttempt: 1,
            scheduledAtIsExact: true,

            status: 'completed',
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

// -----------------------------------------------------------------------------
// §4.5 — the receipt must be authenticated on EVERY tick, not only at seed.
//
// It is stored in a public GitHub issue body and trusted for 24 hours. Checking
// it once at the start leaves 47 later ticks trusting whatever the body says
// now, and the body is editable by anyone with write access to the repository.
// -----------------------------------------------------------------------------
describe('a tampered receipt cannot survive a tick', () => {
  const SECRET = 'tick-test-cron-secret';
  const signedState = (over: Record<string, unknown> = {}) => {
    const r: Record<string, unknown> = {
      notBefore: '2026-09-03T09:00:00.000Z',
      verifiedAt: '2026-09-03T09:02:30.000Z',
      nonce: 'abcd1234abcd1234',
      releaseSha: 'f'.repeat(40),
      environment: 'production',
      serverEventId: 'srv-1',
      browserEventId: 'brw-2',
      serverSource: 'app/api/health/sentry-probe/route.ts',
      browserSource: 'app/probe/sentry/BrowserProbe.tsx',
      sourceMapsPublic: false,
      sourceMapAssets: '/_next/static/chunks/main.js',
      digest: '',
      ...over,
    };
    r.digest = receiptDigest(SECRET, r);
    return r;
  };

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });

  it('nextSentryState carries the digest and sources forward unchanged', () => {
    // If a tick could rewrite these, a tampered receipt would be laundered into
    // a clean one on the next pass.
    const seeded = seedSentryState(JSON.stringify(signedState()))!;
    const after = nextSentryState(seeded, { configured: true, ok: true, problems: [] });
    expect(after.digest).toBe(seeded.digest);
    expect(after.serverSource).toBe(seeded.serverSource);
    expect(after.browserSource).toBe(seeded.browserSource);
    expect(after.sourceMapsPublic).toBe(false);
    expect(after.nonce).toBe(seeded.nonce);
    expect(after.verifiedAt).toBe(seeded.verifiedAt);
  });

  it('a receipt that records PUBLIC source maps cannot be seeded at all', () => {
    expect(() => seedSentryState(JSON.stringify(signedState({ sourceMapsPublic: true })))).toThrow(
      /source maps/i,
    );
  });

  it('an unsigned receipt cannot be seeded', () => {
    const r = signedState();
    delete (r as Record<string, unknown>).digest;
    expect(() => seedSentryState(JSON.stringify(r))).toThrow(/incomplete|digest/i);
  });

  it('a receipt signed with a different key cannot be seeded', () => {
    const r = signedState();
    r.digest = receiptDigest('a-different-secret', r);
    expect(() => seedSentryState(JSON.stringify(r))).toThrow(/integrity/i);
  });

  it('seeding refuses when CRON_SECRET is absent — unauthenticated is not trusted', () => {
    const prev = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      expect(() => seedSentryState(JSON.stringify(signedState()))).toThrow(/CRON_SECRET/);
    } finally {
      process.env.CRON_SECRET = prev;
    }
  });
});

// -----------------------------------------------------------------------------
// The observation-gap limit is calibrated, and its boundary is probed.
//
// It became consequential when it joined SOAK_HEALTH_GATES: before that,
// failing it coloured a tick red and the window carried on. A threshold that
// has never bitten has never been tested against reality, and this one had not:
// at 5h it fired on 1.6% of measured monitor gaps, which is a 38% chance of
// tripping at least once per 24-hour window.
// -----------------------------------------------------------------------------
describe('the observation-gap limit sits above delivery lag and below an outage', () => {
  const at = (h: number) => new Date(new Date(START).getTime() + h * 3_600_000).toISOString();

  const withGap = (gapHours: number) => {
    // Hourly observations for 25 hours, minus a stretch that creates one hole.
    const hours = [];
    for (let h = 1; h <= 25; h++) {
      if (h > 5 && h <= 5 + gapHours - 1) continue;
      hours.push(h);
    }
    return healthyEvidence({
      monitorRuns: hours.map((h, i) => ({
        runId: 400 + i,
        event: 'schedule',
        runAttempt: 1,
        scheduledAtIsExact: true,

        status: 'completed',
        conclusion: 'success',
        completedAt: at(h),
      })),
    });
  };

  it('a 5.2h hole — the worst measured delivery lag — is tolerated', () => {
    const r = evaluateSoak({ state: state(), evidence: withGap(5), now: NOW });
    expect(gate(r, 'observation-gap').ok, gate(r, 'observation-gap').detail).toBe(true);
  });

  it('a 7h hole is not', () => {
    const r = evaluateSoak({ state: state(), evidence: withGap(7), now: NOW });
    expect(gate(r, 'observation-gap').ok).toBe(false);
    // …and because it is a health gate, it stops the clock rather than just
    // showing red.
    expect(r.status).toBe('awaiting-recovery');
  });

  it('the limit is the calibrated value, not an incidental one', () => {
    expect(SOAK_DEFAULTS.maxObservationGapHours).toBe(6);
  });
});

// -----------------------------------------------------------------------------
// A continuing failure is ONE unhealthy episode, not one per tick.
//
// Introduced by the health-gate rule itself: the branch that enters
// awaiting-recovery appended to `restarts`, and `restarts` is persisted, so a
// six-hour Sentry outage would write twelve identical entries — and a day-long
// one, forty-eight. The issue body grows without bound and the real restart
// history drowns in repetitions of the same sentence.
//
// The run-failure path already had this right: it only records when the moment
// is newer than the one already being awaited.
// -----------------------------------------------------------------------------
describe('a continuing failure is recorded once, not once per tick', () => {
  const t0 = new Date(NOW);

  it('THE DEFECT: a second failing tick adds no second restart entry', () => {
    const first = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ outboxDead: 4 }),
      now: t0,
    });
    expect(first.status).toBe('awaiting-recovery');
    expect(first.restarts).toHaveLength(1);

    const second = evaluateSoak({
      state: {
        ...state(),
        awaitingRecoverySince: first.awaitingRecoverySince,
        restarts: first.restarts,
      },
      evidence: healthyEvidence({ outboxDead: 4 }),
      now: new Date(t0.getTime() + 30 * 60_000),
    });
    expect(second.status).toBe('awaiting-recovery');
    expect(second.restarts, 'the same episode must not be recorded twice').toHaveLength(1);
    // …and the episode keeps its ORIGINAL start, so recovery is still required
    // after the moment things actually broke.
    expect(second.awaitingRecoverySince).toBe(first.awaitingRecoverySince);
  });

  it('a NEW failure after a recovery is a new entry', () => {
    // The complement: deduping must not swallow a genuinely separate episode.
    const first = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ outboxDead: 4 }),
      now: t0,
    });
    // Recovered: a healthy scheduled observation after the failure.
    const recoveredAt = new Date(t0.getTime() + 3_600_000);
    const later = new Date(t0.getTime() + 2 * 3_600_000);
    const second = evaluateSoak({
      state: {
        ...state(),
        awaitingRecoverySince: first.awaitingRecoverySince,
        restarts: first.restarts,
      },
      evidence: healthyEvidence({
        monitorRuns: [
          {
            runId: 5001,
            event: 'schedule',
            runAttempt: 1,
            scheduledAtIsExact: true,

            status: 'completed',
            conclusion: 'success',
            completedAt: recoveredAt.toISOString(),
          },
        ],
        outboxDead: 7,
      }),
      now: later,
    });
    expect(second.status).toBe('awaiting-recovery');
    expect(second.restarts.length, 'a separate episode deserves its own entry').toBe(2);
  });
});

// -----------------------------------------------------------------------------
// THE RECEIPT MUST SURVIVE ITS OWN LIFECYCLE.
//
// Every previous test built a receipt whose `verifiedAt` already equalled its
// `notBefore`, signed THAT, and seeded it. The real verifier does not produce
// such a document: it captures `notBefore` before firing the probes and
// `verifiedAt` after they are read back, so the two differ by however long
// verification took.
//
// `receiptDigest()` binds both. `seedSentryState()` then dropped `notBefore`
// and overwrote `verifiedAt` with it, while keeping the original digest — so
// the first tick recomputed the HMAC over a different document and the
// observability gate could never pass. A signature scheme whose own seeding
// step invalidates it.
//
// The fixtures hid it because they were written from the persisted shape
// backwards, instead of from the shape the verifier actually emits.
//
// This test starts where the real data starts.
// -----------------------------------------------------------------------------
describe('a receipt as the VERIFIER emits it survives seeding and every tick', () => {
  const SECRET = 'lifecycle-cron-secret';
  const RELEASE = 'c'.repeat(40);

  /** Byte-for-byte the document scripts/verify-sentry.mjs writes. */
  function verifierReceipt() {
    const notBefore = new Date('2026-09-04T09:00:00.000Z');
    // The probes ran, the events were polled back, the maps were checked.
    const verifiedAt = new Date('2026-09-04T09:03:41.000Z');
    const receipt: Record<string, unknown> = {
      notBefore: notBefore.toISOString(),
      verifiedAt: verifiedAt.toISOString(),
      nonce: 'a1b2c3d4e5f60718',
      releaseSha: RELEASE,
      environment: 'production',
      serverEventId: 'srv-real-1',
      browserEventId: 'brw-real-2',
      serverSource: 'app/api/health/sentry-probe/route.ts',
      browserSource: 'app/probe/sentry/BrowserProbe.tsx',
      sourceMapsPublic: false,
      sourceMapAssets: '/_next/static/chunks/main.js',
      digest: '',
    };
    receipt.digest = receiptDigest(SECRET, receipt);
    return receipt;
  }

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });

  it('THE DEFECT: verifiedAt and notBefore genuinely differ, as they must', () => {
    const r = verifierReceipt();
    expect(r.verifiedAt).not.toBe(r.notBefore);
  });

  it('THE DEFECT: it seeds, and the seeded state still authenticates', () => {
    const seeded = seedSentryState(JSON.stringify(verifierReceipt()));
    expect(seeded).not.toBeNull();
    const v = verifyReceiptIntegrity(SECRET, seeded as never);
    expect(v.ok, `seeded state failed integrity: ${v.reason ?? ''}`).toBe(true);
  });

  it('THE DEFECT: it survives a round trip through the issue body', () => {
    // State is stored as JSON inside a GitHub issue and parsed back next tick.
    const seeded = seedSentryState(JSON.stringify(verifierReceipt()))!;
    const state = {
      releaseSha: RELEASE,
      deploymentId: '99',
      startedAt: '2026-09-04T09:05:00.000Z',
      effectiveWindowStart: '2026-09-04T09:05:00.000Z',
      restarts: [],
      sentry: seeded,
    };
    const recovered = parseState(renderState(state));
    const v = verifyReceiptIntegrity(SECRET, recovered.sentry);
    expect(v.ok, `after a round trip: ${v.reason ?? ''}`).toBe(true);
  });

  it('THE DEFECT: it still authenticates after many ticks', () => {
    let carried = seedSentryState(JSON.stringify(verifierReceipt()))!;
    for (let tick = 0; tick < 48; tick++) {
      carried = nextSentryState(carried, {
        configured: true,
        ok: true,
        serverEventId: 'srv-real-1',
        browserEventId: 'brw-real-2',
        problems: [],
      }) as never;
      const v = verifyReceiptIntegrity(SECRET, carried as never);
      expect(v.ok, `tick ${tick + 1}: ${v.reason ?? ''}`).toBe(true);
    }
  });

  it('the freshness bound stays the START of the run, not the finish', () => {
    // The reason the two fields exist. The events were created between
    // notBefore and verifiedAt, so a bound at verifiedAt rejects them.
    const seeded = seedSentryState(JSON.stringify(verifierReceipt()))!;
    expect(soakFreshnessBound(seeded).toISOString()).toBe('2026-09-04T09:00:00.000Z');
  });

  it('and a tampered field is still caught after all of that', () => {
    // The complement: surviving the lifecycle must not mean surviving edits.
    let carried = seedSentryState(JSON.stringify(verifierReceipt()))!;
    carried = nextSentryState(carried, { configured: true, ok: true, problems: [] }) as never;
    for (const [field, value] of [
      ['serverEventId', 'srv-from-an-old-run'],
      ['releaseSha', 'd'.repeat(40)],
      ['nonce', 'another-nonce'],
      ['verifiedAt', '2020-01-01T00:00:00.000Z'],
      ['notBefore', '2020-01-01T00:00:00.000Z'],
    ] as Array<[string, string]>) {
      const tampered = { ...(carried as Record<string, unknown>), [field]: value };
      expect(verifyReceiptIntegrity(SECRET, tampered as never).ok, field).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
// §3 — a re-run cannot repair a soak window.
//
// "Re-run failed jobs" keeps the `schedule` event, increments `run_attempt`,
// replaces `conclusion` and moves `updated_at`. So before this, an operator
// watching a soak fail at hour 20 could re-run the failed monitor, backup or
// cron run and the next tick would see a clean window — with the added twist
// that `updated_at` moved the failure's apparent time forward, past the
// recovery boundary the controller orders against.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('re-running a failed run cannot repair the window', () => {
  const rerun = (runId: number, hoursAfterStart: number) => ({
    ...run(runId, hoursAfterStart),
    runAttempt: 2,
    scheduledAtIsExact: true,
  });

  it('THE DEFECT: a re-run monitor observation is not a natural observation', () => {
    // Eight observations, but three of them were re-run by hand. Only five are
    // natural, which is below the required six.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        monitorRuns: [
          ...[1, 2, 3, 4, 5].map((n) => run(100 + n, n * 3)),
          ...[6, 7, 8].map((n) => rerun(100 + n, n * 3)),
        ],
      }),
      now: NOW,
    });
    expect(gate(r, 'monitor-observations').ok, 're-runs must not count').toBe(false);
  });

  it('THE DEFECT: a re-run backup does not satisfy the backup gate', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({ backupRuns: [rerun(200, 6)] }),
      now: NOW,
    });
    expect(gate(r, 'scheduled-backup').ok).toBe(false);
  });

  it('THE DEFECT: re-run cron runs do not satisfy the cron count', () => {
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        cronRuns: [rerun(300, 2), rerun(301, 8), rerun(302, 14), rerun(303, 20)],
      }),
      now: NOW,
    });
    expect(gate(r, 'scheduled-cron').ok).toBe(false);
  });

  it('THE DEFECT: a re-run cannot serve as the RECOVERY observation', () => {
    // The most dangerous one. The window is awaiting recovery; an operator
    // re-runs the failed monitor run; if that counted, the window would restart
    // on a button press and start accruing time again.
    const failedAt = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const r = evaluateSoak({
      state: { ...state(), awaitingRecoverySince: failedAt },
      evidence: healthyEvidence({
        monitorRuns: [
          {
            ...run(9001, 0),
            runAttempt: 2,
            scheduledAtIsExact: true,

            completedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
          },
        ],
      }),
      now: NOW,
    });
    expect(r.status, 'recovery must be delivered, not pressed').toBe('awaiting-recovery');
  });

  it('COMPLEMENT: a genuine first-attempt observation after the failure DOES recover it', () => {
    const failedAt = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const r = evaluateSoak({
      state: { ...state(), awaitingRecoverySince: failedAt },
      evidence: healthyEvidence({
        monitorRuns: [
          {
            ...run(9002, 0),
            completedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
          },
        ],
      }),
      now: NOW,
    });
    expect(r.status).not.toBe('awaiting-recovery');
  });

  it('a genuinely failed FIRST attempt still restarts the window', () => {
    // Excluding re-runs must not also hide the original failure — that would
    // be the same erasure by another route.
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        monitorRuns: [
          ...[1, 2, 3, 4, 5, 6, 7].map((n) => run(100 + n, n * 3)),
          run(199, 10, 'failure'),
        ],
      }),
      now: NOW,
    });
    expect(['restarted', 'awaiting-recovery']).toContain(r.status);
  });
});

// -----------------------------------------------------------------------------
// §4 — ALL verdict-relevant state must be tamper-evident, not only the receipt.
//
// The receipt was signed. Everything that actually decides the verdict was not:
// `releaseSha`, `deploymentId`, `startedAt`, `effectiveWindowStart`,
// `awaitingRecoverySince`, `restarts` and `lastProcessedMonitorRun` sat in a
// public GitHub issue body as plain JSON. Optimistic concurrency compares the
// body against what THIS tick read, so it detects an edit made during a tick
// and is blind to one made between ticks — which is 29 of every 30 minutes.
//
// So: backdate `effectiveWindowStart` by a day and the next tick reports 24
// elapsed hours. Delete a restart and the interruption never happened. Swap
// `deploymentId` and the soak silently measures a different deployment.
//
// The signature is not "state never changes" — the controller changes it every
// tick. It is "only something holding CRON_SECRET can produce a valid state",
// which is the same property the receipt has, applied to the rest of the
// document.
//
// Replay is handled separately, by an anchor GitHub owns: the window cannot
// begin before the soak issue that records it exists.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('the whole soak state is tamper-evident', () => {
  const SECRET = 'state-integrity-secret';
  const ISSUE_CREATED = '2026-09-01T00:00:00Z';

  const signedState = (over: Record<string, unknown> = {}) => {
    const st: Record<string, unknown> = {
      schemaVersion: SOAK_STATE_VERSION,
      releaseSha: SHA,
      deploymentId: '6221617929',
      startedAt: START,
      effectiveWindowStart: START,
      awaitingRecoverySince: null,
      restarts: [],
      lastProcessedMonitorRun: 107,
      tickSeq: 3,
      ...over,
    };
    st.stateDigest = soakStateDigest(SECRET, st);
    return st;
  };

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });

  it('a state the controller signed verifies', () => {
    expect(verifySoakState(SECRET, signedState(), ISSUE_CREATED)).toEqual({ ok: true });
  });

  it('THE DEFECT: backdating the window is caught', () => {
    const st = signedState();
    st.effectiveWindowStart = '2026-08-20T00:00:00Z';
    expect(verifySoakState(SECRET, st, ISSUE_CREATED).ok).toBe(false);
  });

  it('THE DEFECT: deleting a restart is caught', () => {
    const st = signedState({ restarts: [{ at: START, reason: 'something broke' }] });
    st.restarts = [];
    expect(verifySoakState(SECRET, st, ISSUE_CREATED).ok).toBe(false);
  });

  it('THE DEFECT: replacing the deployment or the release is caught', () => {
    for (const [field, value] of [
      ['deploymentId', '999999'],
      ['releaseSha', 'e'.repeat(40)],
      ['startedAt', '2026-08-01T00:00:00Z'],
      ['awaitingRecoverySince', null],
      ['lastProcessedMonitorRun', 1],
      ['tickSeq', 99],
    ] as Array<[string, unknown]>) {
      const st = signedState({ awaitingRecoverySince: '2026-09-01T12:00:00Z' });
      st[field] = value;
      expect(verifySoakState(SECRET, st, ISSUE_CREATED).ok, field).toBe(false);
    }
  });

  it('an unsigned state is refused — absence is not permission', () => {
    const st = signedState();
    delete st.stateDigest;
    const v = verifySoakState(SECRET, st, ISSUE_CREATED);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not signed/i);
  });

  it('a state signed with another key is refused', () => {
    const st: Record<string, unknown> = { ...signedState(), stateDigest: '' };
    st.stateDigest = soakStateDigest('another-secret', st);
    expect(verifySoakState(SECRET, st, ISSUE_CREATED).ok).toBe(false);
  });

  it('THE REPLAY: a validly signed window cannot predate the issue recording it', () => {
    // Signature alone does not stop replaying an OLDER valid body, and an older
    // body has an earlier window start — which is more elapsed time, i.e. the
    // attacker's goal. The issue's own creation time is an anchor GitHub owns
    // and the body cannot move.
    const st = signedState({
      effectiveWindowStart: '2026-08-25T00:00:00Z',
      startedAt: '2026-08-25T00:00:00Z',
    });
    const v = verifySoakState(SECRET, st, ISSUE_CREATED);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/before the soak issue/i);
  });

  it('field order does not change the digest', () => {
    const a = signedState();
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    expect(verifySoakState(SECRET, reordered as never, ISSUE_CREATED).ok).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The lifecycle version of §4: a state the controller writes must verify on the
// next tick, and every field a gate reads must be inside the signature.
// -----------------------------------------------------------------------------
describe('signed state survives its own lifecycle', () => {
  const SECRET = 'lifecycle-state-secret';
  const ISSUE_CREATED = START;

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });

  it('a freshly created state verifies, round-trips, and verifies again', () => {
    const created: Record<string, unknown> = {
      schemaVersion: SOAK_STATE_VERSION,
      tickSeq: 0,
      releaseSha: SHA,
      deploymentId: '6221617929',
      startedAt: START,
      effectiveWindowStart: START,
      awaitingRecoverySince: null,
      restarts: [],
      lastProcessedMonitorRun: null,
      lastTickAt: null,
    };
    created.stateDigest = soakStateDigest(SECRET, created);
    expect(verifySoakState(SECRET, created, ISSUE_CREATED).ok).toBe(true);

    const recovered = parseState(renderState(created));
    expect(verifySoakState(SECRET, recovered, ISSUE_CREATED).ok).toBe(true);
  });

  it('every field the evaluator reads from state is a known semantic field', () => {
    // The signature now covers a canonical DEEP serialisation of everything
    // except the presentation list, so this asserts the SCHEMA rather than an
    // inclusion list — a nested value can no longer be semantic and unsigned.
    for (const field of [
      'releaseSha',
      'deploymentId',
      'startedAt',
      'effectiveWindowStart',
      'awaitingRecoverySince',
      'restarts',
      'lastProcessedMonitorRun',
      'sentry',
    ]) {
      expect(SOAK_SEMANTIC_FIELDS, `${field} is read by a gate`).toContain(field);
    }
  });

  it('lastTickAt is deliberately NOT signed — it decides nothing', () => {
    expect(SOAK_SEMANTIC_FIELDS).not.toContain('lastTickAt');
  });

  it('a receipt cannot be moved between two soaks', () => {
    // The receipt's own digest is bound into the state digest, so lifting a
    // valid receipt out of one soak and into another invalidates the state.
    const base: Record<string, unknown> = {
      schemaVersion: SOAK_STATE_VERSION,
      tickSeq: 1,
      releaseSha: SHA,
      deploymentId: '1',
      startedAt: START,
      effectiveWindowStart: START,
      awaitingRecoverySince: null,
      restarts: [],
      lastProcessedMonitorRun: 1,
      sentry: { digest: 'a'.repeat(64) },
    };
    base.stateDigest = soakStateDigest(SECRET, base);
    expect(verifySoakState(SECRET, base, ISSUE_CREATED).ok).toBe(true);

    const swapped = { ...base, sentry: { digest: 'b'.repeat(64) } };
    expect(verifySoakState(SECRET, swapped, ISSUE_CREATED).ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// §8 — old events staying readable is not proof that new ones are ingested.
//
// Every tick re-fetched the SAME two events, created before the soak began. If
// the DSN is revoked at hour 3, a quota is hit, an inbound filter is added or
// the transport breaks, those two events remain perfectly readable through
// Sentry's API for the whole window — and the observability gate stays green
// while nothing new can arrive.
//
// So the receipt has to be refreshed inside the window, at a bounded cadence,
// and the soak cannot certify 24 hours on a verification done before hour zero.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('the soak requires ONGOING proof of ingestion', () => {
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

  const withProof = (hoursAgo: number | null) =>
    healthyEvidence({
      sentry: {
        configured: true,
        ok: true,
        serverEventId: 'srv-abc',
        browserEventId: 'brw-def',
        problems: [],
        verifiedAt: hoursAgo === null ? null : at(hoursAgo),
      },
    });

  it('THE DEFECT: a proof from before the window does not certify it', () => {
    // The window is 25 hours old; the only verification happened before it
    // started. Caught by the age limit rather than by an explicit in-window
    // test — see the livelock note below for why that distinction matters.
    const r = evaluateSoak({ state: state(), evidence: withProof(26), now: NOW });
    const g = gate(r, 'observability-continuing');
    expect(g, 'there must be a gate for this at all').toBeDefined();
    expect(g.ok, 'a pre-window verification cannot cover the window').toBe(false);
    expect(g.detail).toMatch(/stale/i);
  });

  it('the age limit is what enforces in-window, without livelocking a restart', () => {
    // Requiring the proof to POSTDATE the window start livelocks: a restart
    // begins a new window, every existing proof predates it, the gate fails,
    // the failure is a health gate, and the soak returns to awaiting-recovery
    // forever.
    //
    // The age limit gives the stronger property where it matters. Success needs
    // 24 elapsed hours and the cadence is 6, so any proof fresh enough to pass
    // at success time is inside the window by 18 hours.
    expect(SOAK_DEFAULTS.maxObservabilityProofAgeHours).toBeLessThan(SOAK_DEFAULTS.windowHours);

    // A window that has just restarted keeps a recent proof rather than
    // discarding it.
    const justRestarted = state({
      effectiveWindowStart: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    const g = gate(
      evaluateSoak({ state: justRestarted, evidence: withProof(1), now: NOW }),
      'observability-continuing',
    );
    expect(g.ok, 'a fresh proof survives a restart').toBe(true);
  });

  it('a proof within the cadence satisfies it', () => {
    expect(
      gate(
        evaluateSoak({ state: state(), evidence: withProof(2), now: NOW }),
        'observability-continuing',
      ).ok,
    ).toBe(true);
  });

  it('a proof older than the cadence does not', () => {
    const limit = SOAK_DEFAULTS.maxObservabilityProofAgeHours;
    expect(
      gate(
        evaluateSoak({ state: state(), evidence: withProof(limit + 1), now: NOW }),
        'observability-continuing',
      ).ok,
    ).toBe(false);
    expect(
      gate(
        evaluateSoak({ state: state(), evidence: withProof(limit - 1), now: NOW }),
        'observability-continuing',
      ).ok,
    ).toBe(true);
  });

  it('no proof at all is not health', () => {
    expect(
      gate(
        evaluateSoak({ state: state(), evidence: withProof(null), now: NOW }),
        'observability-continuing',
      ).ok,
    ).toBe(false);
  });

  it('it is a HEALTH gate, so a lapse stops the clock', () => {
    // Ingestion breaking mid-window is a release-critical failure, not slow
    // progress: the window it would otherwise certify was unobserved.
    expect(SOAK_HEALTH_GATES).toContain('observability-continuing');
    const r = evaluateSoak({ state: state(), evidence: withProof(26), now: NOW });
    expect(r.status).toBe('awaiting-recovery');
  });

  it('the cadence is bounded, so this cannot become event spam', () => {
    // This used to assert bounds on the EXPIRY, conflating it with the cadence
    // — which was the defect: both were six hours and there was no margin for
    // scheduling delay. The volume is set by the cadence; the expiry is how
    // much delay that volume can absorb.
    expect(SOAK_DEFAULTS.observabilityRefreshCadenceHours).toBeGreaterThanOrEqual(3);
    expect(SOAK_DEFAULTS.observabilityRefreshCadenceHours).toBeLessThanOrEqual(8);
  });
});

describe('an absent signing key is an error, not a silent downgrade', () => {
  it('signing with no secret throws rather than digesting "undefined"', () => {
    // Otherwise signing and verifying would both hash the string "undefined"
    // and agree — a signature scheme that authenticates nothing.
    expect(() => soakStateDigest(undefined as never, { releaseSha: 'x' })).toThrow(/CRON_SECRET/);
    expect(() => soakStateDigest('', { releaseSha: 'x' })).toThrow(/CRON_SECRET/);
  });
});

// -----------------------------------------------------------------------------
// §2.1 — a hand-maintained list of top-level field names is not "all
// verdict-relevant state signed".
//
// `SOAK_SIGNED_FIELDS` named eight top-level keys plus `sentry.digest`. It
// therefore did NOT cover `sentry.lastFreshProofAt`, which is the single value
// the `observability-continuing` gate reads. An issue editor could future-date
// it and `stateDigest` stayed valid — and because the gate compared an age
// rather than validating the timestamp, a future date produced a negative age
// that sailed under the maximum.
//
// The lesson is the list itself: any manual enumeration of "the important
// fields" is one nested value behind the code that reads them. So the digest
// now covers a canonical DEEP serialisation of the whole semantic state, under
// a schema version, with unknown fields rejected rather than ignored.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('every semantic leaf is signed, however deeply nested', () => {
  const SECRET = 'deep-signing-secret';
  const ISSUE_AT = START;

  const base = () => ({
    schemaVersion: SOAK_STATE_VERSION,
    tickSeq: 4,
    releaseSha: SHA,
    deploymentId: '6221617929',
    startedAt: START,
    effectiveWindowStart: START,
    awaitingRecoverySince: null,
    restarts: [{ at: START, reason: 'something broke' }],
    lastProcessedMonitorRun: 107,
    sentry: {
      notBefore: '2026-09-01T00:00:00.000Z',
      verifiedAt: '2026-09-01T00:03:00.000Z',
      nonce: 'abcd1234abcd1234',
      releaseSha: SHA,
      environment: 'production',
      serverEventId: 'srv-1',
      browserEventId: 'brw-2',
      serverSource: 'app/api/health/sentry-probe/route.ts',
      browserSource: 'app/probe/sentry/BrowserProbe.tsx',
      sourceMapsPublic: false,
      sourceMapAssets: '/_next/static/chunks/main.js',
      digest: 'a'.repeat(64),
      configured: true,
      lastRevalidationOk: true,
      lastProblems: [],
    },
  });

  const signed = (over: Record<string, unknown> = {}) => {
    const st = { ...base(), ...over } as Record<string, unknown>;
    st.stateDigest = soakStateDigest(SECRET, st);
    return st;
  };

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });

  it('a signed state verifies', () => {
    expect(verifySoakState(SECRET, signed(), ISSUE_AT)).toEqual({ ok: true });
  });

  it('THE DEFECT: mutating a NESTED sentry field invalidates the state', () => {
    for (const field of [
      'nonce',
      'verifiedAt',
      'notBefore',
      'serverEventId',
      'browserEventId',
      'serverSource',
      'browserSource',
      'sourceMapAssets',
      'sourceMapsPublic',
      'digest',
      'releaseSha',
      'environment',
    ]) {
      const st = signed();
      (st.sentry as Record<string, unknown>)[field] = 'tampered';
      expect(verifySoakState(SECRET, st, ISSUE_AT).ok, `sentry.${field}`).toBe(false);
    }
  });

  it('mutating a restart entry — at any depth — invalidates the state', () => {
    const st = signed();
    (st.restarts as Array<{ reason: string }>)[0].reason = 'nothing happened';
    expect(verifySoakState(SECRET, st, ISSUE_AT).ok).toBe(false);
  });

  it('THE DEFECT: an unknown semantic field is rejected, not ignored', () => {
    // Ignoring one is how a future field gets added, read by a gate, and never
    // covered — which is exactly how lastFreshProofAt happened.
    const st = signed();
    (st as Record<string, unknown>).somethingNew = 'x';
    const v = verifySoakState(SECRET, st, ISSUE_AT);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/unknown/i);
  });

  it('a schema version mismatch is refused', () => {
    const st = signed({ schemaVersion: SOAK_STATE_VERSION + 1 });
    expect(verifySoakState(SECRET, st, ISSUE_AT).ok).toBe(false);
  });

  it('presentation-only fields are excluded, and only those', () => {
    // lastTickAt decides nothing. Changing it must not invalidate a state, or
    // every tick would have to be re-signed for a cosmetic value.
    const st = signed();
    (st as Record<string, unknown>).lastTickAt = new Date().toISOString();
    expect(verifySoakState(SECRET, st, ISSUE_AT).ok).toBe(true);
    expect(SOAK_PRESENTATION_FIELDS).toEqual(['lastTickAt']);
  });

  it('key order never changes the digest, at any depth', () => {
    // A round trip through JSON, or through GitHub's issue body, can reorder
    // keys. It must not look like tampering. (The first version of this test
    // used a JSON.stringify replacer ARRAY, which filters keys rather than
    // reordering them — it dropped every nested value and proved nothing.)
    const reverseKeysDeep = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reverseKeysDeep);
      if (v && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .reverse()
            .map(([k, val]) => [k, reverseKeysDeep(val)]),
        );
      }
      return v;
    };
    const a = signed();
    const reordered = reverseKeysDeep(a) as Record<string, unknown>;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(a));
    expect(verifySoakState(SECRET, reordered, ISSUE_AT).ok).toBe(true);
  });
});

describe('Sentry freshness comes from the SIGNED verifier timestamp', () => {
  const SECRET = 'freshness-secret';

  it('THE DEFECT: freshness is derived from sentry.verifiedAt, not a local now', () => {
    // `lastFreshProofAt` was written by the controller from its own clock and
    // was outside both HMACs. The verifier's own completion time is signed, so
    // it cannot be moved without breaking the receipt.
    const at = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    expect(sentryProofAge({ verifiedAt: at }, NOW)).toBeCloseTo(2, 1);
  });

  it('a future timestamp is refused, not treated as very fresh', () => {
    // A negative age passed `age <= limit` silently — future-dating the field
    // made the gate greener than green.
    const future = new Date(NOW.getTime() + 3_600_000).toISOString();
    expect(sentryProofAge({ verifiedAt: future }, NOW)).toBeNull();
  });

  it('a small forward skew is tolerated, a large one is not', () => {
    const smallSkew = new Date(NOW.getTime() + 30_000).toISOString();
    expect(sentryProofAge({ verifiedAt: smallSkew }, NOW)).not.toBeNull();
    const bigSkew = new Date(NOW.getTime() + 20 * 60_000).toISOString();
    expect(sentryProofAge({ verifiedAt: bigSkew }, NOW)).toBeNull();
  });

  it('a malformed or absent timestamp is refused', () => {
    for (const bad of [undefined, null, '', 'soon', '2026-13-45T99:99:99Z']) {
      expect(sentryProofAge({ verifiedAt: bad as string }, NOW), String(bad)).toBeNull();
    }
  });

  it('the gate reads it, so a future-dated proof cannot pass', () => {
    const future = new Date(NOW.getTime() + 3_600_000).toISOString();
    const r = evaluateSoak({
      state: state(),
      evidence: healthyEvidence({
        sentry: {
          configured: true,
          ok: true,
          serverEventId: 's',
          browserEventId: 'b',
          problems: [],
          verifiedAt: future,
        },
      }),
      now: NOW,
    });
    expect(gate(r, 'observability-continuing').ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// §2.2 — signing does not stop REPLAY, and the issue-creation anchor only
// catches a window that predates its own issue.
//
// Restoring an EARLIER valid body of the SAME issue defeats both. It carries a
// genuine signature, a window that postdates the issue, and — crucially — a
// state from before a release-critical failure. The restart is erased, the
// clock resumes from the older window, and every check passes.
//
// A signed `tickSeq` alone cannot help: the attacker restores the body that
// contains the older `tickSeq`, and there is nothing to compare it against.
// It needs an EXTERNAL monotonic reference the body cannot rewrite.
//
// The controller therefore posts a checkpoint comment each tick. GitHub comment
// ids are monotonic and are not part of the issue body, so:
//
//   rollback     the newest checkpoint's digest will not match the restored
//                body;
//   deletion     `tickSeq` values must form a contiguous run, so a hole is
//                visible;
//   forking      two checkpoints claiming the same tickSeq is a fork;
//   reordering   comment id order must agree with tickSeq order.
//
// Documented limitation, and it fails closed rather than pretending otherwise:
// an actor with repository write can delete every checkpoint. The controller
// then sees no chain for an existing soak and refuses, rather than silently
// accepting whatever the body says.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('an earlier valid body of the same issue cannot be replayed', () => {
  const cp = (tickSeq: number, digest: string, id: number) => ({
    id,
    body: renderCheckpoint({ tickSeq, stateDigest: digest }),
  });

  it('the newest checkpoint must match the state being read', () => {
    const v = verifyCheckpointChain([cp(1, 'a'.repeat(64), 10), cp(2, 'b'.repeat(64), 20)], {
      tickSeq: 2,
      stateDigest: 'b'.repeat(64),
    });
    expect(v).toEqual({ ok: true });
  });

  it('THE REPLAY: an earlier body is refused even though it is validly signed', () => {
    // The attacker restores tick 1's body. Its signature is genuine; the chain
    // says the last thing this controller wrote was tick 2.
    const v = verifyCheckpointChain([cp(1, 'a'.repeat(64), 10), cp(2, 'b'.repeat(64), 20)], {
      tickSeq: 1,
      stateDigest: 'a'.repeat(64),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/older than the latest checkpoint|rolled back/i);
  });

  it('a matching tickSeq with a different digest is refused', () => {
    const v = verifyCheckpointChain([cp(1, 'a'.repeat(64), 10)], {
      tickSeq: 1,
      stateDigest: 'c'.repeat(64),
    });
    expect(v.ok).toBe(false);
  });

  it('a DELETED checkpoint leaves a hole, and a hole fails closed', () => {
    const v = verifyCheckpointChain([cp(1, 'a'.repeat(64), 10), cp(3, 'c'.repeat(64), 30)], {
      tickSeq: 3,
      stateDigest: 'c'.repeat(64),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/gap|contiguous|missing/i);
  });

  it('a FORK — two checkpoints claiming the same tick — fails closed', () => {
    // Both digests must be valid hex, or the parser rejects one as malformed
    // and there is no fork left to detect.
    const v = verifyCheckpointChain([cp(1, 'a'.repeat(64), 10), cp(1, '9'.repeat(64), 11)], {
      tickSeq: 1,
      stateDigest: 'a'.repeat(64),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/twice|duplicate|fork/i);
  });

  it('REORDERING — a later tick posted under an earlier comment id — fails closed', () => {
    const v = verifyCheckpointChain([cp(2, 'b'.repeat(64), 10), cp(1, 'a'.repeat(64), 20)], {
      tickSeq: 2,
      stateDigest: 'b'.repeat(64),
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/order/i);
  });

  it('NO chain at all for an existing soak fails closed', () => {
    const v = verifyCheckpointChain([], { tickSeq: 5, stateDigest: 'd'.repeat(64) });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no checkpoint/i);
  });

  it('a brand new soak — tick 0, no checkpoints yet — is allowed', () => {
    expect(verifyCheckpointChain([], { tickSeq: 0, stateDigest: 'e'.repeat(64) })).toEqual({
      ok: true,
    });
  });

  it('ordinary sequential ticks keep working', () => {
    const chain = [cp(1, 'a'.repeat(64), 10), cp(2, 'b'.repeat(64), 20), cp(3, 'c'.repeat(64), 30)];
    expect(verifyCheckpointChain(chain, { tickSeq: 3, stateDigest: 'c'.repeat(64) }).ok).toBe(true);
  });

  it('non-checkpoint comments are ignored, not misread', () => {
    const noise = [{ id: 15, body: 'a human said something here' }];
    const chain = [cp(1, 'a'.repeat(64), 10), ...noise, cp(2, 'b'.repeat(64), 20)];
    expect(verifyCheckpointChain(chain, { tickSeq: 2, stateDigest: 'b'.repeat(64) }).ok).toBe(true);
  });

  it('a checkpoint round-trips through its rendered form', () => {
    const rendered = renderCheckpoint({ tickSeq: 7, stateDigest: 'f'.repeat(64) });
    expect(parseCheckpoint(rendered)).toEqual({ tickSeq: 7, stateDigest: 'f'.repeat(64) });
    expect(parseCheckpoint('not a checkpoint')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// §2.4 — the continuing-observability proof must be UNATTENDED.
//
// `sentry-reverify.yml` allowed `workflow_dispatch`, and neither the workflow
// nor the controller looked at how it had been triggered. So the one gate that
// exists to prove production is still ingesting events could be refreshed by
// pressing a button — or by re-running a failed refresh until it passed. That
// is the manual-evidence defect again, on the newest gate.
//
// Provenance is now bound into the signed state and independently confirmed
// against GitHub, rather than trusted from the environment the workflow handed
// us: a workflow can be edited, and `GITHUB_EVENT_NAME` is just a string.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('only a natural first-attempt run may refresh the Sentry proof', () => {
  const env = (over: Record<string, string> = {}) => ({
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_RUN_ID: '900',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: SHA,
    ...over,
  });
  const apiRun = (over: Record<string, unknown> = {}) => ({
    id: 900,
    event: 'schedule',
    run_attempt: 1,
    created_at: '2026-09-02T00:30:00Z',
    head_sha: SHA,
    ...over,
  });
  const persisted = { verifiedAt: '2026-09-01T18:00:00.000Z' };
  const receipt = { verifiedAt: '2026-09-02T00:31:00.000Z', releaseSha: SHA };

  it('a scheduled first attempt is accepted', () => {
    expect(verifyReverifyProvenance(env(), apiRun(), persisted, receipt)).toEqual({ ok: true });
  });

  it('THE DEFECT: a manual dispatch may not refresh the proof', () => {
    const v = verifyReverifyProvenance(
      env({ GITHUB_EVENT_NAME: 'workflow_dispatch' }),
      apiRun({ event: 'workflow_dispatch' }),
      persisted,
      receipt,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/workflow_dispatch|not scheduled/i);
  });

  it('THE DEFECT: a re-run may not refresh the proof', () => {
    const v = verifyReverifyProvenance(
      env({ GITHUB_RUN_ATTEMPT: '2' }),
      apiRun({ run_attempt: 2 }),
      persisted,
      receipt,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/attempt/i);
  });

  it('provenance is confirmed against GitHub, not taken from the environment', () => {
    // The environment claims a scheduled first attempt; GitHub says otherwise.
    // A workflow file can be edited; the API record cannot.
    const v = verifyReverifyProvenance(
      env(),
      apiRun({ event: 'workflow_dispatch' }),
      persisted,
      receipt,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/disagrees|GitHub/i);
  });

  it('an unreadable run record fails closed', () => {
    expect(verifyReverifyProvenance(env(), null, persisted, receipt).ok).toBe(false);
  });

  it('THE DEFECT: an OLD receipt cannot be restamped as fresh', () => {
    // Constructed to isolate this rule from the "before the run" rule: the
    // receipt is verified AFTER the run started, so that check passes, but
    // BEFORE the proof already held. Accepting it would let a stale receipt
    // reset the freshness clock indefinitely.
    const held = { verifiedAt: '2026-09-02T01:00:00.000Z' };
    const stale = { verifiedAt: '2026-09-02T00:45:00.000Z', releaseSha: SHA };
    const v = verifyReverifyProvenance(env(), apiRun(), held, stale);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/older|not newer/i);
  });

  it('a receipt for a different release is refused', () => {
    const other = { verifiedAt: '2026-09-02T00:31:00.000Z', releaseSha: 'f'.repeat(40) };
    const v = verifyReverifyProvenance(env(), apiRun(), persisted, other);
    expect(v.ok).toBe(false);
  });

  it('the run head SHA must match the release under soak', () => {
    const v = verifyReverifyProvenance(
      env(),
      apiRun({ head_sha: 'e'.repeat(40) }),
      persisted,
      receipt,
    );
    expect(v.ok).toBe(false);
  });

  it('the verification must have happened during that run, not before it', () => {
    // A receipt produced before the refreshing run even started is one the run
    // did not produce.
    const early = { verifiedAt: '2026-09-01T23:00:00.000Z', releaseSha: SHA };
    const v = verifyReverifyProvenance(env(), apiRun(), { verifiedAt: null }, early);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/before the run/i);
  });

  it('the bound provenance names everything a later reader needs', () => {
    const p = reverifyProvenance(env(), apiRun(), receipt);
    expect(p).toEqual({
      event: 'schedule',
      runId: 900,
      runAttempt: 1,
      runCreatedAt: '2026-09-02T00:30:00Z',
      headSha: SHA,
      verifiedAt: '2026-09-02T00:31:00.000Z',
      releaseSha: SHA,
    });
  });
});

// -----------------------------------------------------------------------------
// §2.5 — the refresh cadence and the proof expiry must not be the same number.
//
// They were both six hours, which left exactly zero margin for GitHub's
// scheduling delay, npm install, Chromium install, Sentry indexing and queue
// time. Any one of those made the gate fail for reasons that had nothing to do
// with production — and because it is a HEALTH gate, each of those failures
// restarted the window.
//
// Measured lag on this account: p95 4.13h, p99 5.03h. Cadence is now 4h and
// expiry 14h.
// -----------------------------------------------------------------------------
describe('the proof cadence leaves room for real scheduling delay', () => {
  const withProofAge = (hoursAgo: number, now: Date) =>
    healthyEvidence({
      sentry: {
        configured: true,
        ok: true,
        serverEventId: 's',
        browserEventId: 'b',
        problems: [],
        verifiedAt: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(),
      },
    });
  const ok = (hoursAgo: number) =>
    gate(
      evaluateSoak({ state: state(), evidence: withProofAge(hoursAgo, NOW), now: NOW }),
      'observability-continuing',
    ).ok;

  it('cadence and expiry are different numbers, and expiry is the larger', () => {
    expect(SOAK_DEFAULTS.observabilityRefreshCadenceHours).toBe(4);
    expect(SOAK_DEFAULTS.maxObservabilityProofAgeHours).toBe(14);
    expect(SOAK_DEFAULTS.maxObservabilityProofAgeHours).toBeGreaterThan(
      SOAK_DEFAULTS.observabilityRefreshCadenceHours * 2,
    );
  });

  it('normal runtime delay: cadence plus p99 lag plus ten minutes still passes', () => {
    expect(ok(4 + 5.03 + 10 / 60)).toBe(true);
  });

  it('ONE dropped schedule at p95 lag still passes', () => {
    expect(ok(2 * 4 + 4.13 + 10 / 60)).toBe(true);
  });

  it('a genuine prolonged ingestion outage does NOT pass', () => {
    // Two consecutive dropped schedules, or an outage. Deliberately over the
    // line: a window nobody was proving ingestion for is not one to certify.
    expect(ok(2 * 4 + 4.13 + 10 / 60 + 2)).toBe(false);
    expect(ok(20)).toBe(false);
  });

  it('and it stops the clock, because it is a health gate', () => {
    const r = evaluateSoak({ state: state(), evidence: withProofAge(20, NOW), now: NOW });
    expect(r.status).toBe('awaiting-recovery');
  });

  it('recovery: a new proof after the outage clears it', () => {
    expect(ok(0.5)).toBe(true);
  });

  it('a healthy 24h window is not restarted by the cadence itself', () => {
    // The scenario that matters most: with the proof refreshed on cadence, a
    // clean window must reach success rather than being nibbled to death by its
    // own freshness requirement.
    const r = evaluateSoak({ state: state(), evidence: withProofAge(3, NOW), now: NOW });
    expect(r.status).toBe('success');
  });

  it('the daily probe volume stays bounded', () => {
    const pairsPerDay = 24 / SOAK_DEFAULTS.observabilityRefreshCadenceHours;
    expect(pairsPerDay).toBe(6);
    expect(pairsPerDay * 2, 'synthetic events per day').toBe(12);
  });
});
