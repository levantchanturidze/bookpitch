// -----------------------------------------------------------------------------
// What makes a Sentry event actual RECEIPT evidence.
//
// The previous path proved almost nothing:
//
//   * verify-sentry.mjs wrote a receipt to a local file that nothing imported
//     into durable soak state;
//   * it emitted through the Node SDK even when the receipt was labelled
//     `browser`, so one runtime's event could satisfy both fields;
//   * the synthetic envelope carried no production exception and no stack, so
//     source maps were never exercised;
//   * level 5 only proved a lookup returned HTTP 200 — not that the event was
//     the one just emitted, from the right release, in the right environment;
//   * `sourceMapsResolved` was a boolean somebody passed in;
//   * persisted ids were tied to nothing, so a months-old event kept passing.
//
// This module is the judgement, kept pure so it can be tested against captured
// Sentry API fixtures rather than against a live project. The IO lives in
// scripts/verify-sentry.mjs and the soak controller.
// -----------------------------------------------------------------------------

export type SentryRuntime = 'server' | 'browser';

/** The subset of a Sentry event payload this check reads. */
export type SentryEvent = {
  id?: string;
  eventID?: string;
  dateCreated?: string;
  environment?: string;
  release?: string;
  tags?: Array<{ key: string; value: string }>;
  entries?: Array<{
    type: string;
    data?: {
      values?: Array<{
        stacktrace?: { frames?: SentryFrame[] };
      }>;
    };
  }>;
};

export type SentryFrame = {
  filename?: string;
  absPath?: string;
  function?: string;
  lineNo?: number;
  /** Sentry sets this when the frame was resolved through an uploaded map. */
  inApp?: boolean;
  /** Present only when Sentry could map the frame back to original source. */
  context?: Array<[number, string]>;
};

export type ReceiptExpectation = {
  runtime: SentryRuntime;
  /** Exact release the deployment is serving. */
  releaseSha: string;
  /** Exact production environment name. */
  environment: string;
  /** Unique per verification run, so an old event cannot satisfy a new check. */
  nonce: string;
  /** Events older than this were not produced by this verification. */
  notBefore: Date;
};

export type ReceiptVerdict = {
  ok: boolean;
  eventId: string | null;
  /** Derived from the event's own frames, never supplied by a caller. */
  symbolicated: boolean;
  problems: string[];
};

function tag(event: SentryEvent, key: string): string | undefined {
  return event.tags?.find((t) => t.key === key)?.value;
}

/**
 * True when at least one stack frame was genuinely resolved through an
 * uploaded source map.
 *
 * The signal is `context`: Sentry populates it with surrounding lines of
 * ORIGINAL source, which it can only do when a map resolved. A minified frame
 * has a filename and a line number and no context, so checking for a filename
 * — or trusting a boolean — would pass on exactly the unreadable stack this
 * exists to rule out.
 *
 * Frames from the bundle itself are also excluded: a `.js` chunk path with
 * context lines is the minified file, not original source.
 */
export function isSymbolicated(event: SentryEvent): boolean {
  const frames =
    event.entries
      ?.filter((e) => e.type === 'exception')
      .flatMap((e) => e.data?.values ?? [])
      .flatMap((v) => v.stacktrace?.frames ?? []) ?? [];
  return frames.some(
    (f) =>
      Array.isArray(f.context) &&
      f.context.length > 0 &&
      typeof f.filename === 'string' &&
      // Original source, not a built chunk.
      !/\/_next\/static\/chunks\//.test(f.filename) &&
      !/\.min\.js$/.test(f.filename),
  );
}

/**
 * Check one Sentry event against what this verification run actually emitted.
 *
 * Every clause exists because its absence let something through: without the
 * nonce an old event passes; without `notBefore` a cached one does; without
 * the runtime tag the same event satisfies both server and browser; without
 * release and environment an event from staging or a previous deploy counts.
 */
export function verifyReceipt(
  event: SentryEvent | null,
  expect: ReceiptExpectation,
): ReceiptVerdict {
  const problems: string[] = [];
  if (!event) {
    return {
      ok: false,
      eventId: null,
      symbolicated: false,
      problems: ['no event was retrievable from Sentry'],
    };
  }

  const eventId = event.id ?? event.eventID ?? null;
  if (!eventId) problems.push('the event carries no id');

  if (event.environment !== expect.environment) {
    problems.push(`environment is ${event.environment ?? '(none)'}, expected ${expect.environment}`);
  }
  if (event.release !== expect.releaseSha) {
    problems.push(
      `release is ${event.release ?? '(none)'}, expected ${expect.releaseSha.slice(0, 12)}`,
    );
  }
  if (tag(event, 'bookpitch_verification_nonce') !== expect.nonce) {
    problems.push('the verification nonce does not match this run — the event may be an old one');
  }
  if (tag(event, 'bookpitch_runtime') !== expect.runtime) {
    problems.push(
      `runtime tag is ${tag(event, 'bookpitch_runtime') ?? '(none)'}, expected ${expect.runtime}`,
    );
  }
  const created = event.dateCreated ? new Date(event.dateCreated) : null;
  if (!created || Number.isNaN(created.getTime())) {
    problems.push('the event carries no usable timestamp');
  } else if (created < expect.notBefore) {
    problems.push(
      `event timestamp ${created.toISOString()} predates this verification run — not fresh`,
    );
  }

  const symbolicated = isSymbolicated(event);
  return { ok: problems.length === 0, eventId, symbolicated, problems };
}

/**
 * Both runtimes together, which is what the soak's observability gate needs.
 *
 * Requires distinct event ids: emitting once through the Node SDK and reusing
 * the id for both fields is exactly what the previous implementation did.
 */
export function verifyReceiptPair(input: {
  server: ReceiptVerdict;
  browser: ReceiptVerdict;
}): { ok: boolean; problems: string[]; symbolicated: boolean } {
  const problems = [
    ...input.server.problems.map((p) => `server: ${p}`),
    ...input.browser.problems.map((p) => `browser: ${p}`),
  ];
  if (
    input.server.eventId &&
    input.browser.eventId &&
    input.server.eventId === input.browser.eventId
  ) {
    problems.push('server and browser report the SAME event id — only one runtime was exercised');
  }
  // At least one runtime must prove symbolication. Requiring both would fail on
  // a server frame that legitimately has no map (a dependency), while requiring
  // neither is how `sourceMapsResolved` became a boolean nobody checked.
  const symbolicated = input.server.symbolicated || input.browser.symbolicated;
  if (!symbolicated) {
    problems.push(
      'no stack frame in either event resolved to original source — production stacks are ' +
        'unreadable minified frames, which is a subtler way of having no Sentry at all',
    );
  }
  return { ok: problems.length === 0, problems, symbolicated };
}
