import { describe, it, expect } from 'vitest';
import {
  planSentryReconciliation,
  CHECK_ID,
  OWNED_CHECK_IDS,
} from '../scripts/sentry-incident.mjs';
import { reconcileIncidents, incidentMarker } from '../scripts/production-monitor.mjs';

// -----------------------------------------------------------------------------
// The Sentry verifier owns ONE incident class and must touch nothing else.
//
// `sentry-incident.mjs` passed a single result to `reconcileIncidents`, which
// sweeps for incidents that no check reported and closes them as orphans — on
// the reasonable assumption that its caller reported every check. The Sentry
// verifier reports one. So every other open `ops-incident` looked abandoned.
//
// Reproduced against the real reconciler before the fix: outcome `unavailable`,
// with #44 (its own) plus #90 `ops-metrics` and #91 `backup-workflow-stale`
// open, produced
//
//   toClose -> [ { n: 90, orphaned: true }, { n: 91, orphaned: true } ]
//
// and the caller closes each `toClose` entry with the comment "Resolved by
// end-to-end verification." A run that could not reach Sentry at all would have
// declared two unrelated production incidents resolved, by evidence it never
// gathered.
//
// The rule: a caller may retire only the incident classes it actually reports.
// -----------------------------------------------------------------------------

const outcomes = {
  verified: { state: 'verified', summary: 'delivered and symbolicated in both runtimes' },
  failed: {
    state: 'failed',
    summary: 'the browser event never arrived',
    problems: ['no browser event'],
  },
  unavailable: { state: 'unavailable', summary: 'no authenticated Sentry access' },
  indeterminate: { state: 'indeterminate', summary: 'the run produced no outcome document' },
} as const;

/** #44 is the verifier's own incident; the rest belong to the monitor. */
const own = () => ({
  number: 44,
  state: 'open',
  title: '[ops] Application errors are not being reported anywhere',
  body: incidentMarker(CHECK_ID),
});
const unrelated = () => [
  { number: 90, state: 'open', title: '[ops] metrics', body: incidentMarker('ops-metrics') },
  {
    number: 91,
    state: 'open',
    title: '[ops] backup',
    body: incidentMarker('backup-workflow-stale'),
  },
  {
    number: 92,
    state: 'open',
    title: '[ops] tls',
    body: incidentMarker('tls-certificate-expiring'),
  },
];

/** Every issue number the plan would act on, by any route. */
function touched(plan: ReturnType<typeof planSentryReconciliation>['plan']): number[] {
  return [
    ...plan.toComment.map((c) => c.issue.number),
    ...plan.toClose.map((c) => c.issue.number),
    ...plan.toReopen.map((c) => c.issue.number),
    ...plan.toCloseDuplicate.map((c) => c.issue.number),
  ].sort((a, b) => a - b);
}

describe('the Sentry verifier acts only on the incident it owns', () => {
  for (const [state, outcome] of Object.entries(outcomes)) {
    it(`THE DEFECT: outcome "${state}" leaves every unrelated incident alone`, () => {
      const { plan } = planSentryReconciliation(outcome, [own(), ...unrelated()], []);
      for (const n of [90, 91, 92]) {
        expect(touched(plan), `#${n} is not this verifier's to judge`).not.toContain(n);
      }
    });

    it(`outcome "${state}" does not open a new issue for someone else's check`, () => {
      const { plan } = planSentryReconciliation(outcome, [own(), ...unrelated()], []);
      expect(plan.toOpen.every((o) => o.result.id === CHECK_ID)).toBe(true);
    });
  }

  it('THE DEFECT, most sharply: an unreachable Sentry closes nothing', () => {
    // The worst case. The verifier learned nothing at all, and before the fix
    // this plan closed #90, #91 and #92 as "Resolved by end-to-end
    // verification."
    const { plan, verified } = planSentryReconciliation(
      outcomes.unavailable,
      [own(), ...unrelated()],
      [],
    );
    expect(verified).toBe(false);
    expect(plan.toClose, 'a failed verification closes nothing, ever').toEqual([]);
  });

  it('an unrelated incident is not swept even when Sentry is verified', () => {
    const { plan } = planSentryReconciliation(outcomes.verified, [own(), ...unrelated()], []);
    expect(plan.toClose.map((c) => c.issue.number)).toEqual([44]);
    expect(
      plan.toClose[0].orphaned,
      'its own closure is a recovery, not an orphan',
    ).toBeUndefined();
  });
});

describe('legitimate canonical reconciliation still works', () => {
  it('a verified outcome closes its own incident', () => {
    const { verified, plan } = planSentryReconciliation(outcomes.verified, [own()], []);
    expect(verified).toBe(true);
    expect(plan.toClose.map((c) => c.issue.number)).toEqual([44]);
  });

  it('a failed outcome comments on its own open incident', () => {
    const { plan } = planSentryReconciliation(outcomes.failed, [own()], []);
    expect(plan.toComment.map((c) => c.issue.number)).toEqual([44]);
    expect(plan.toClose).toEqual([]);
  });

  it('a wrongly closed incident is REOPENED, not duplicated', () => {
    const closed = [{ ...own(), state: 'closed' }];
    const { plan } = planSentryReconciliation(outcomes.unavailable, [], closed);
    expect(plan.toReopen.map((c) => c.issue.number)).toEqual([44]);
    expect(plan.toOpen, 'a new issue would strand the history on #44').toEqual([]);
  });

  it('a duplicate of its own incident is still folded into the canonical one', () => {
    const dup = { number: 67, state: 'open', title: '[ops] dup', body: incidentMarker(CHECK_ID) };
    const { plan } = planSentryReconciliation(
      outcomes.unavailable,
      [own(), dup, ...unrelated()],
      [],
    );
    expect(plan.toCloseDuplicate.map((c) => c.issue.number)).toEqual([67]);
    expect(plan.toCloseDuplicate[0].canonical.number).toBe(44);
    // …and still nothing else.
    expect(touched(plan).filter((n) => n > 80)).toEqual([]);
  });

  it('with no incident at all, a failure opens exactly one', () => {
    const { plan } = planSentryReconciliation(outcomes.unavailable, unrelated(), []);
    expect(plan.toOpen).toHaveLength(1);
    expect(plan.toOpen[0].result.id).toBe(CHECK_ID);
    expect(touched(plan), 'and touches none of the others').toEqual([]);
  });

  it('the owned set is exactly the one class it verifies', () => {
    expect([...OWNED_CHECK_IDS]).toEqual([CHECK_ID]);
  });
});

// -----------------------------------------------------------------------------
// The reconciler's own contract, since the fix lives there.
// -----------------------------------------------------------------------------
describe('retiring an unreported check requires declared authority', () => {
  const passing = { id: 'health-endpoint', title: 'h', ok: true, detail: 'y' };
  const stranger = [
    { number: 11, state: 'open', title: '[ops] gone', body: incidentMarker('some-other-check') },
  ];

  it('the DEFAULT retires nothing it did not report', () => {
    // Fail closed. A caller that says nothing about its coverage is assumed to
    // have partial coverage, because that assumption's failure mode is an
    // incident left open rather than one wrongly closed.
    const { toClose } = reconcileIncidents([passing], stranger);
    expect(toClose).toEqual([]);
  });

  it("'all' restores the sweep, and only the monitor declares it", async () => {
    const { toClose } = reconcileIncidents([passing], stranger, [], { ownedCheckIds: 'all' });
    expect(toClose).toHaveLength(1);
    expect(toClose[0].orphaned).toBe(true);

    const { readFileSync } = await import('node:fs');
    const monitor = readFileSync('scripts/production-monitor.mjs', 'utf8');
    expect(monitor, 'the monitor must claim it explicitly').toContain("ownedCheckIds: 'all'");
  });

  it('an explicit list retires those ids and no others', () => {
    const issues = [
      ...stranger,
      { number: 12, state: 'open', title: '[ops] mine', body: incidentMarker('mine') },
    ];
    const { toClose } = reconcileIncidents([passing], issues, [], { ownedCheckIds: ['mine'] });
    expect(toClose.map((c) => c.issue.number)).toEqual([12]);
  });

  it('an unobservable check outside the scope gets no comment either', () => {
    // The unobservable branch runs before the orphan close, so the scope guard
    // has to sit ahead of both or an unrelated incident still gets written to.
    const results = [{ id: 'ops-metrics', title: 'ops', ok: false, detail: '503' }, passing];
    const issues = [
      {
        number: 26,
        state: 'open',
        title: '[ops] config',
        body: incidentMarker('production-config-invalid'),
      },
    ];
    const scoped = reconcileIncidents(results, issues, [], { ownedCheckIds: ['health-endpoint'] });
    expect(scoped.toComment.map((c) => c.issue.number)).toEqual([]);

    // COMPLEMENT: the monitor, which owns everything, still says why it cannot
    // see it. This is incident #26's protection and must not regress.
    const full = reconcileIncidents(results, issues, [], { ownedCheckIds: 'all' });
    expect(full.toComment.map((c) => c.issue.number)).toEqual([26]);
    expect(full.toComment[0].unobservable).toBe(true);
    expect(full.toClose).toEqual([]);
  });
});
