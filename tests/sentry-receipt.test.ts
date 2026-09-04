import { describe, it, expect } from 'vitest';
import {
  verifyReceipt,
  verifyReceiptPair,
  isSymbolicated,
  PROBE_SOURCES,
  receiptDigest,
  verifyReceiptIntegrity,
  classifyMapProbe,
  summariseMapProbes,
  RECEIPT_BOUND_FIELDS,
  classifyVerifierOutcome,
  shouldCloseObservabilityIncident,
} from '../scripts/sentry-receipt.mjs';

/** Shape of the Sentry API event payload these tests build. */
type SentryEvent = Record<string, unknown>;

// -----------------------------------------------------------------------------
// §3 — what counts as Sentry RECEIPT evidence.
//
// Tested against captured Sentry API response shapes rather than a live
// project, because no Sentry workspace is accessible. The production gate stays
// failed; the judgement is what is proven here.
//
// Everything below exists because its absence let something through:
//
//   * no nonce            → a months-old event satisfies a fresh check;
//   * no timestamp bound  → a cached event does;
//   * no runtime tag      → one Node-SDK event satisfies BOTH server and
//                           browser, which is exactly what the previous
//                           implementation did;
//   * no release check    → an event from a previous deploy counts;
//   * no environment      → an event from staging counts;
//   * a `sourceMapsResolved` boolean → nobody ever computed it.
// -----------------------------------------------------------------------------

const RELEASE = 'a'.repeat(40);
const NONCE = 'nonce-abc12345';
const NOT_BEFORE = new Date('2026-09-03T00:00:00Z');

/** A Sentry API event as returned by /projects/{org}/{proj}/events/{id}/. */
function event(over: Partial<SentryEvent> = {}): SentryEvent {
  return {
    id: 'srv-1111',
    dateCreated: '2026-09-03T00:05:00Z',
    environment: 'production',
    release: RELEASE,
    tags: [
      { key: 'bookpitch_verification_nonce', value: NONCE },
      { key: 'bookpitch_runtime', value: 'server' },
    ],
    entries: [
      {
        type: 'exception',
        data: {
          values: [
            {
              stacktrace: {
                frames: [
                  // A minified frame: filename and line, no original source.
                  { filename: '/_next/static/chunks/4f2a.js', lineNo: 1, inApp: true },
                  // A symbolicated frame: Sentry resolved it through a map and
                  // attached surrounding lines of ORIGINAL source.
                  {
                    filename: 'app/api/health/sentry-probe/route.ts',
                    function: 'POST',
                    lineNo: 88,
                    inApp: true,
                    context: [
                      [86, '  const release = deployedReleaseSha();'],
                      [87, '  const eventId = Sentry.captureException('],
                      [88, '    new BookpitchSentryProbeError(nonce),'],
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    ],
    ...over,
  };
}

const expectation = {
  runtime: 'server' as const,
  releaseSha: RELEASE,
  environment: 'production',
  nonce: NONCE,
  notBefore: NOT_BEFORE,
};

describe('a Sentry event is receipt only when it is THIS run’s event', () => {
  it('accepts a matching, fresh, symbolicated event', () => {
    const v = verifyReceipt(event(), expectation);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.eventId).toBe('srv-1111');
    expect(v.symbolicated).toBe(true);
  });

  it('rejects a missing event rather than treating absence as agreement', () => {
    const v = verifyReceipt(null, expectation);
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/no event was retrievable/);
  });

  it('THE REGRESSION: an old event with the wrong nonce is refused', () => {
    const v = verifyReceipt(
      event({ tags: [{ key: 'bookpitch_verification_nonce', value: 'some-old-nonce' }] }),
      expectation,
    );
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/nonce does not match/);
  });

  it('THE REGRESSION: an event predating the run is refused even with the right nonce', () => {
    const v = verifyReceipt(event({ dateCreated: '2026-09-02T23:00:00Z' }), expectation);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/predates this verification run/);
  });

  it('refuses an event from a different release', () => {
    const v = verifyReceipt(event({ release: 'b'.repeat(40) }), expectation);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/release is/);
  });

  it('refuses an event from a different environment', () => {
    const v = verifyReceipt(event({ environment: 'preview' }), expectation);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/environment is preview/);
  });

  it('refuses a server event offered as browser receipt', () => {
    const v = verifyReceipt(event(), { ...expectation, runtime: 'browser' });
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/runtime tag is server, expected browser/);
  });
});

describe('symbolication is derived from the event, not asserted', () => {
  it('a stack of only minified frames is NOT symbolicated', () => {
    const minified = event({
      entries: [
        {
          type: 'exception',
          data: {
            values: [
              {
                stacktrace: {
                  frames: [
                    { filename: '/_next/static/chunks/4f2a.js', lineNo: 1, inApp: true },
                    { filename: '/_next/static/chunks/9bb1.js', lineNo: 1, inApp: true },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    expect(isSymbolicated(minified)).toBe(false);
  });

  it('a built chunk WITH context is still not original source', () => {
    // The trap: Sentry can attach context for the minified file itself. A
    // filename check alone would pass on exactly the unreadable stack this
    // exists to rule out.
    const chunkContext = event({
      entries: [
        {
          type: 'exception',
          data: {
            values: [
              {
                stacktrace: {
                  frames: [
                    {
                      filename: '/_next/static/chunks/4f2a.js',
                      lineNo: 1,
                      context: [[1, 'e.default=function(){...}']],
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    expect(isSymbolicated(chunkContext)).toBe(false);
  });

  it('an event with no stack at all is not symbolicated', () => {
    // The old verifier posted a synthetic envelope with no exception, so this
    // was the shape it was actually proving things about.
    expect(isSymbolicated(event({ entries: [] }))).toBe(false);
  });
});

describe('the pair must exercise two runtimes', () => {
  // The browser event must resolve to the BROWSER probe's own file. It used to
  // inherit the server route's frame from the shared fixture, which passed —
  // and that is exactly the hole: a readable server stack is not evidence that
  // the browser bundle's maps were uploaded.
  const browser = () =>
    verifyReceipt(
      event({
        id: 'brw-2222',
        tags: [
          { key: 'bookpitch_verification_nonce', value: NONCE },
          { key: 'bookpitch_runtime', value: 'browser' },
        ],
        entries: [
          {
            type: 'exception',
            data: {
              values: [
                {
                  stacktrace: {
                    frames: [
                      { filename: '/_next/static/chunks/4f2a.js', lineNo: 1, inApp: true },
                      {
                        filename: 'app/probe/sentry/BrowserProbe.tsx',
                        lineNo: 55,
                        inApp: true,
                        context: [[55, '      const id = Sentry.captureException(']],
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      }),
      { ...expectation, runtime: 'browser' },
    );

  it('accepts two distinct, valid events', () => {
    const r = verifyReceiptPair({
      server: verifyReceipt(event(), expectation),
      browser: browser(),
    });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.symbolicated).toBe(true);
  });

  it('THE REGRESSION: the same event id cannot satisfy both runtimes', () => {
    const one = verifyReceipt(event(), expectation);
    const r = verifyReceiptPair({ server: one, browser: { ...one } });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/SAME event id/);
  });

  it('two valid events with no symbolicated frame anywhere fail', () => {
    const bare = { ...verifyReceipt(event(), expectation), symbolicated: false };
    const r = verifyReceiptPair({ server: bare, browser: { ...bare, eventId: 'brw-2222' } });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/unreadable minified frames/);
  });

  it('surfaces which runtime failed, not just that something did', () => {
    const r = verifyReceiptPair({
      server: verifyReceipt(event({ release: 'c'.repeat(40) }), expectation),
      browser: browser(),
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/^server: /);
  });
});

// -----------------------------------------------------------------------------
// Defects found by the final false-green review. Written to FAIL first.
// -----------------------------------------------------------------------------
describe('source-map proof must be original repository source', () => {
  const withFrame = (frame: Record<string, unknown>) =>
    event({
      entries: [{ type: 'exception', data: { values: [{ stacktrace: { frames: [frame] } }] } }],
    });

  it('THE DEFECT: a compiled SERVER chunk with context is not source-map proof', () => {
    // The exclusion list only covered /_next/static/chunks/ and .min.js, so a
    // server-side build artefact with context lines passed as "original
    // source" — which is precisely the unreadable stack the check exists to
    // rule out, just on the other side of the app.
    expect(
      isSymbolicated(
        withFrame({
          filename: '.next/server/app/api/health/sentry-probe/route.js',
          lineNo: 1,
          context: [[1, 'const e=require("...")']],
        }),
      ),
    ).toBe(false);
  });

  it('any compiled .js with context is refused, wherever it lives', () => {
    for (const filename of [
      '/var/task/.next/server/chunks/123.js',
      'dist/index.js',
      '/_next/static/abc.js',
      'webpack-internal:///./lib/x.js',
    ]) {
      expect(
        isSymbolicated(withFrame({ filename, lineNo: 1, context: [[1, 'x']] })),
        `${filename} must not count as original source`,
      ).toBe(false);
    }
  });

  it('a dependency frame in node_modules is not our source map', () => {
    expect(
      isSymbolicated(
        withFrame({
          filename: 'node_modules/@sentry/node/build/cjs/index.ts',
          lineNo: 5,
          context: [[5, 'export function init() {}']],
        }),
      ),
    ).toBe(false);
  });

  it('accepts .ts and .tsx repository source with context', () => {
    for (const filename of ['app/api/health/route.ts', 'components/legal/LegalPage.tsx']) {
      expect(
        isSymbolicated(withFrame({ filename, lineNo: 12, context: [[12, 'const x = 1;']] })),
        `${filename} should count`,
      ).toBe(true);
    }
  });
});

describe('each runtime must prove its OWN symbolication', () => {
  const verdict = (over: Record<string, unknown>) => ({
    ok: true,
    eventId: 'x',
    symbolicated: false,
    problems: [] as string[],
    ...over,
  });

  it('THE DEFECT: a symbolicated server event must not cover an unsymbolicated browser one', () => {
    // `server.symbolicated || browser.symbolicated` meant uploading server maps
    // alone satisfied the gate, while every browser stack stayed minified.
    const r = verifyReceiptPair({
      server: verdict({ eventId: 'srv-1', symbolicated: true }),
      browser: verdict({ eventId: 'brw-2', symbolicated: false }),
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/browser/);
  });

  it('and the reverse', () => {
    const r = verifyReceiptPair({
      server: verdict({ eventId: 'srv-1', symbolicated: false }),
      browser: verdict({ eventId: 'brw-2', symbolicated: true }),
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/server/);
  });

  it('both symbolicated passes', () => {
    const r = verifyReceiptPair({
      server: verdict({ eventId: 'srv-1', symbolicated: true }),
      browser: verdict({ eventId: 'brw-2', symbolicated: true }),
    });
    expect(r.ok).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// §4.5 — symbolication must prove THIS stack is readable, not some stack.
//
// `isSymbolicated()` accepted any `.ts`/`.tsx` frame carrying context. So a
// middleware file, a library helper, or anything else that happened to resolve
// satisfied it while the probe's own frame stayed minified — and the receipt
// then asserted "source maps are proven" about a stack nobody could read.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('symbolication is checked against the probe’s own source file', () => {
  const withFrames = (frames: Array<Record<string, unknown>>, over: Partial<SentryEvent> = {}) =>
    event({
      entries: [{ type: 'exception', data: { values: [{ stacktrace: { frames } }] } }],
      ...over,
    });

  const ctx = [[1, 'const x = 1;']];

  it('THE DEFECT: an unrelated readable file does not prove the probe resolved', () => {
    const v = verifyReceipt(
      withFrames([{ filename: 'lib/logger.ts', lineNo: 1, context: ctx }]),
      expectation,
    );
    expect(v.symbolicated).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/app\/api\/health\/sentry-probe\/route\.ts/);
    // The message names what DID resolve, so the failure is diagnosable.
    expect(v.problems.join(' ')).toMatch(/lib\/logger\.ts/);
  });

  it('the server probe’s own file counts', () => {
    const v = verifyReceipt(
      withFrames([{ filename: 'app/api/health/sentry-probe/route.ts', lineNo: 88, context: ctx }]),
      expectation,
    );
    expect(v.symbolicated).toBe(true);
  });

  it('a leading slash or project-root prefix still matches', () => {
    for (const filename of [
      '/app/api/health/sentry-probe/route.ts',
      '/vercel/path0/app/api/health/sentry-probe/route.ts',
    ]) {
      expect(
        verifyReceipt(withFrames([{ filename, lineNo: 88, context: ctx }]), expectation)
          .symbolicated,
        filename,
      ).toBe(true);
    }
  });

  it('THE DEFECT: the SERVER file does not satisfy a BROWSER event', () => {
    const v = verifyReceipt(
      withFrames([{ filename: 'app/api/health/sentry-probe/route.ts', lineNo: 88, context: ctx }], {
        tags: [
          { key: 'bookpitch_verification_nonce', value: NONCE },
          { key: 'bookpitch_runtime', value: 'browser' },
        ],
      }),
      { ...expectation, runtime: 'browser' },
    );
    expect(v.symbolicated, 'each runtime must prove its OWN maps').toBe(false);
  });

  it('the browser probe’s own file counts for a browser event', () => {
    const v = verifyReceipt(
      withFrames([{ filename: 'app/probe/sentry/BrowserProbe.tsx', lineNo: 55, context: ctx }], {
        tags: [
          { key: 'bookpitch_verification_nonce', value: NONCE },
          { key: 'bookpitch_runtime', value: 'browser' },
        ],
      }),
      { ...expectation, runtime: 'browser' },
    );
    expect(v.symbolicated).toBe(true);
  });

  it('reports the resolved sources so a receipt can record them', () => {
    const v = verifyReceipt(
      withFrames([
        { filename: 'app/api/health/sentry-probe/route.ts', lineNo: 88, context: ctx },
        { filename: 'lib/logger.ts', lineNo: 3, context: ctx },
        { filename: '/_next/static/chunks/x.js', lineNo: 1 },
      ]),
      expectation,
    );
    expect(v.sources).toContain('app/api/health/sentry-probe/route.ts');
    expect(v.sources).not.toContain('/_next/static/chunks/x.js');
  });

  it('the declared probe sources are files that actually exist', async () => {
    // Otherwise a rename would silently make symbolication unsatisfiable, and
    // the failure would read as "Sentry is broken".
    const { existsSync } = await import('node:fs');
    for (const f of Object.values(PROBE_SOURCES)) {
      expect(existsSync(f), `${f} does not exist`).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// §4.5 — the receipt is the thing the soak trusts for 24 hours, so it must be
// impossible to edit into something that passes.
//
// The receipt travels as a workflow input and is then stored in a public GitHub
// issue body. Anyone who can dispatch the workflow, or edit the issue, could
// substitute event ids from an old verification run against an old release —
// and every subsequent tick would "revalidate" them happily, because the fields
// it checks would all agree with each other.
//
// So the receipt carries an HMAC over its own bound fields, keyed with
// CRON_SECRET, which both the verifier and the soak controller already hold.
// Changing any bound field without the key invalidates it.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('a receipt is tamper-evident', () => {
  const SECRET = 'cron-secret-for-receipt-tests';
  const receipt = () => ({
    notBefore: '2026-09-04T09:00:00.000Z',
    verifiedAt: '2026-09-04T09:02:30.000Z',
    nonce: NONCE,
    releaseSha: RELEASE,
    environment: 'production',
    serverEventId: 'srv-1',
    browserEventId: 'brw-2',
    serverSource: 'app/api/health/sentry-probe/route.ts',
    browserSource: 'app/probe/sentry/BrowserProbe.tsx',
    sourceMapsPublic: false,
  });

  it('a signed receipt verifies', () => {
    const r = { ...receipt(), digest: '' };
    r.digest = receiptDigest(SECRET, r);
    expect(verifyReceiptIntegrity(SECRET, r)).toEqual({ ok: true });
  });

  it('THE DEFECT: swapping an event id invalidates it', () => {
    const r = { ...receipt(), digest: '' };
    r.digest = receiptDigest(SECRET, r);
    const tampered = { ...r, serverEventId: 'srv-from-an-old-run' };
    expect(verifyReceiptIntegrity(SECRET, tampered).ok).toBe(false);
  });

  it('every bound field is actually bound', () => {
    const base = { ...receipt(), digest: '' };
    base.digest = receiptDigest(SECRET, base);
    const edits: Array<[string, unknown]> = [
      ['notBefore', '2020-01-01T00:00:00.000Z'],
      ['verifiedAt', '2020-01-01T00:00:00.000Z'],
      ['nonce', 'some-other-nonce'],
      ['releaseSha', 'b'.repeat(40)],
      ['environment', 'preview'],
      ['serverEventId', 'other'],
      ['browserEventId', 'other'],
      ['serverSource', 'lib/logger.ts'],
      ['browserSource', 'lib/logger.ts'],
      ['sourceMapsPublic', true],
    ];
    for (const [field, value] of edits) {
      const tampered = { ...base, [field]: value };
      expect(verifyReceiptIntegrity(SECRET, tampered).ok, `${field} is not bound`).toBe(false);
    }
  });

  it('a receipt signed with a different key does not verify', () => {
    const r = { ...receipt(), digest: '' };
    r.digest = receiptDigest('some-other-secret', r);
    expect(verifyReceiptIntegrity(SECRET, r).ok).toBe(false);
  });

  it('a receipt with no digest at all is refused, not waved through', () => {
    expect(verifyReceiptIntegrity(SECRET, receipt() as never).ok).toBe(false);
    expect(verifyReceiptIntegrity(SECRET, { ...receipt(), digest: '' }).ok).toBe(false);
    expect(verifyReceiptIntegrity(SECRET, null as never).ok).toBe(false);
  });

  it('a receipt claiming PUBLIC source maps can never be valid', () => {
    // Signed correctly, and still refused: publishing the unminified source is
    // a finding in itself, and a receipt is an assertion that the release is
    // fit to soak.
    const r = { ...receipt(), sourceMapsPublic: true, digest: '' };
    r.digest = receiptDigest(SECRET, r);
    const v = verifyReceiptIntegrity(SECRET, r);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/source maps/i);
  });

  it('field order does not change the digest — canonical serialisation', () => {
    const a = { ...receipt(), digest: '' };
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as typeof a;
    expect(receiptDigest(SECRET, a)).toBe(receiptDigest(SECRET, reordered));
  });
});

// -----------------------------------------------------------------------------
// §5 — a negative claim cannot rest on a request that did not complete.
//
// The old check called ANY non-2xx "not publicly served". So a 429 from a
// throttled CDN, a 502, a redirect to a login page, or a network error all
// counted as proof of privacy — and it only sampled the first three chunks it
// happened to find on the landing page, which are not the assets the browser
// probe runs from.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('a source-map probe only passes on an explicit absence', () => {
  it('a 2xx is exposure', () => {
    expect(classifyMapProbe({ status: 200 })).toBe('exposed');
    expect(classifyMapProbe({ status: 206 })).toBe('exposed');
  });

  it('404 and 410 are the only proofs of absence', () => {
    expect(classifyMapProbe({ status: 404 })).toBe('private');
    expect(classifyMapProbe({ status: 410 })).toBe('private');
  });

  it('THE DEFECT: throttling, server errors and redirects are NOT proof', () => {
    for (const status of [301, 302, 307, 401, 403, 429, 500, 502, 503, 504]) {
      expect(classifyMapProbe({ status }), String(status)).toBe('indeterminate');
    }
  });

  it('a transport failure is not proof either', () => {
    expect(classifyMapProbe({ error: 'ECONNRESET' })).toBe('indeterminate');
    expect(classifyMapProbe({})).toBe('indeterminate');
  });

  it('403 is deliberately not "private"', () => {
    // A CDN that forbids us may still serve the file to someone else, and some
    // hosts answer 403 when rate limiting.
    expect(classifyMapProbe({ status: 403 })).toBe('indeterminate');
  });
});

describe('the map verdict fails closed', () => {
  const probe = (url: string, classification: string) => ({ url, classification });

  it('THE DEFECT: discovering nothing to check is a failure, not a pass', () => {
    const v = summariseMapProbes([]);
    expect(v.ok).toBe(false);
    expect(v.sourceMapsPublic).toBeNull();
    expect(v.problems.join(' ')).toMatch(/no source-map probe was performed/);
  });

  it('all private is the only pass', () => {
    const v = summariseMapProbes([probe('/a.js.map', 'private'), probe('/b.js.map', 'private')]);
    expect(v).toEqual({ ok: true, sourceMapsPublic: false, problems: [] });
  });

  it('one exposed map fails and names it', () => {
    const v = summariseMapProbes([probe('/a.js.map', 'private'), probe('/b.js.map', 'exposed')]);
    expect(v.ok).toBe(false);
    expect(v.sourceMapsPublic).toBe(true);
    expect(v.problems.join(' ')).toMatch(/b\.js\.map/);
  });

  it('THE DEFECT: one indeterminate probe fails the whole check', () => {
    const v = summariseMapProbes([
      probe('/a.js.map', 'private'),
      probe('/b.js.map', 'indeterminate'),
    ]);
    expect(v.ok, 'unknown is not private').toBe(false);
    expect(v.sourceMapsPublic, 'and it is not recorded as false either').toBeNull();
    expect(v.problems.join(' ')).toMatch(/fails closed/);
  });

  it('the checked assets are bound into the signature', () => {
    expect(RECEIPT_BOUND_FIELDS).toContain('sourceMapAssets');
    expect(RECEIPT_BOUND_FIELDS).toContain('sourceMapsPublic');
  });
});

// -----------------------------------------------------------------------------
// §2.6 — "we could not check" is not "delivery is broken", and neither is
// silence.
//
// The monitor detects only that DSN variable NAMES are unset. Revoked,
// mistyped, filtered, quota-exhausted or wrong-project DSNs all leave that check
// green. And a failed `sentry-reverify` exited before the controller, created no
// incident, and outside an active soak did nothing at all — so a production
// where errors had silently stopped being delivered looked identical to one
// where they were.
//
// Three failure states, deliberately distinct, because they need different
// responses and conflating them is how an operator learns to ignore the alarm:
//
//   unavailable     the check could not start — no DSN, no secrets. Nothing is
//                   known, and nothing is claimed.
//   indeterminate   the check started and could not finish — API denied, quota,
//                   transport failure, an ambiguous source-map response.
//   broken          confirmed: events were emitted and did not arrive, or
//                   arrived unusable, or the maps are public.
//
// Written to FAIL first.
// -----------------------------------------------------------------------------
describe('a verifier outcome is classified honestly', () => {
  it('a full pass is verified', () => {
    const o = classifyVerifierOutcome({ proven: 5, problems: [], mapVerdict: { ok: true } });
    expect(o.state).toBe('verified');
  });

  it('missing inputs are UNAVAILABLE, not broken', () => {
    const o = classifyVerifierOutcome({ proven: 0, missingInputs: ['SENTRY_AUTH_TOKEN'] });
    expect(o.state).toBe('unavailable');
    expect(o.summary).toMatch(/could not be attempted/i);
  });

  it('a deployment with no DSN is UNAVAILABLE', () => {
    const o = classifyVerifierOutcome({ proven: 0, problems: ['the deployment reports no SENTRY_DSN'] });
    expect(o.state).toBe('unavailable');
  });

  it('an API refusal is INDETERMINATE, not confirmed delivery failure', () => {
    const o = classifyVerifierOutcome({
      proven: 3,
      problems: ['Sentry API refused the token (HTTP 403)'],
    });
    expect(o.state).toBe('indeterminate');
    // It must not CLAIM confirmation. It may — and should — say the opposite:
    // asserting "not a confirmed failure" is the whole point of the state.
    expect(o.summary).not.toMatch(/^CONFIRMED/);
    expect(o.summary).toMatch(/NOT a confirmed delivery failure/);
  });

  it('an ambiguous source-map response is INDETERMINATE', () => {
    const o = classifyVerifierOutcome({
      proven: 5,
      problems: [],
      mapVerdict: { ok: false, sourceMapsPublic: null, problems: ['could not establish'] },
    });
    expect(o.state).toBe('indeterminate');
  });

  it('events emitted but never retrievable is BROKEN', () => {
    const o = classifyVerifierOutcome({
      proven: 3,
      problems: ['server NOT retrievable, browser NOT retrievable'],
    });
    expect(o.state).toBe('broken');
  });

  it('publicly served source maps is BROKEN', () => {
    const o = classifyVerifierOutcome({
      proven: 5,
      problems: [],
      mapVerdict: { ok: false, sourceMapsPublic: true, problems: ['publicly readable'] },
    });
    expect(o.state).toBe('broken');
  });

  it('only "verified" may close the incident', () => {
    for (const state of ['unavailable', 'indeterminate', 'broken']) {
      expect(shouldCloseObservabilityIncident({ state }), state).toBe(false);
    }
    expect(shouldCloseObservabilityIncident({ state: 'verified' })).toBe(true);
  });

  it('the summary carries no secret, DSN, token or cookie', () => {
    const o = classifyVerifierOutcome({
      proven: 2,
      problems: [
        'https://abc123deadbeef@o1.ingest.sentry.io/42 rejected',
        'Bearer sntrys_abcdef',
        '__Host-bookpitch-sentry-probe=9f2c',
      ],
    });
    const text = `${o.summary} ${o.problems.join(' ')}`;
    expect(text).not.toMatch(/ingest\.sentry\.io/);
    expect(text).not.toMatch(/sntrys_/);
    expect(text).not.toMatch(/__Host-/);
    expect(text, 'and it must still say something useful').toMatch(/redacted/i);
  });
});
