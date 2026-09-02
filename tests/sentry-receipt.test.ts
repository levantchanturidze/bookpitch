import { describe, it, expect } from 'vitest';
import { verifyReceipt, verifyReceiptPair, isSymbolicated } from '../scripts/sentry-receipt.mjs';

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
  const browser = () =>
    verifyReceipt(
      event({
        id: 'brw-2222',
        tags: [
          { key: 'bookpitch_verification_nonce', value: NONCE },
          { key: 'bookpitch_runtime', value: 'browser' },
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
