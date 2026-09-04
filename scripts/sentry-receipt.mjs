import { createHmac, timingSafeEqual } from 'node:crypto';
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
//
// Deliberately .mjs, not .ts: scripts/soak-controller.mjs runs under plain Node
// in a workflow, and Node cannot import a .ts file. An earlier draft had the
// controller do `await import('../lib/sentry-receipt.ts')`, which type-checks
// and passes every unit test — and would have thrown the first time the
// workflow ran, in the one code path nothing else exercises.
// -----------------------------------------------------------------------------

function tag(event, key) {
  return event.tags?.find((t) => t.key === key)?.value;
}

/**
 * True when at least one stack frame resolves to ORIGINAL REPOSITORY SOURCE.
 *
 * Two signals, both required:
 *
 *   context   Sentry populates it with surrounding lines of original source,
 *             which it can only do when a map resolved. A minified frame has a
 *             filename and a line number and no context.
 *   filename  must be a `.ts`/`.tsx` file that is not a dependency.
 *
 * The filename half is the part that was wrong. An earlier version excluded
 * only `/_next/static/chunks/` and `.min.js`, so a SERVER build artefact —
 * `.next/server/app/api/.../route.js` — with context lines counted as original
 * source. That is the same unreadable stack the check exists to rule out, just
 * on the other side of the application, and it would have made "source maps
 * are proven" true while every server stack was compiled output.
 *
 * An allow-list, not a deny-list. A deny-list of build-output shapes has to be
 * complete to be correct, and build tools invent new ones.
 */

// -----------------------------------------------------------------------------
// Receipt integrity.
//
// The receipt is what the soak trusts for 24 hours. It travels as a workflow
// input and is then stored in a public GitHub issue body, so anyone who can
// dispatch the workflow or edit the issue could substitute event ids from an
// older verification run against an older release — and every subsequent tick
// would revalidate them happily, because the fields it checks would all agree
// with each other. Internal consistency is not integrity.
//
// So the receipt carries an HMAC over its own bound fields, keyed with
// CRON_SECRET, which the verifier and the soak controller both already hold and
// neither ever prints. Editing any bound field without the key invalidates it.
//
// This is deliberately not a signature scheme with separate keys: the threat is
// a hand-edited issue body, not a compromised verifier. A shared secret both
// sides already possess is the right weight.
// -----------------------------------------------------------------------------

/**
 * Fields the digest covers. Everything that decides whether the receipt is
 * evidence about THIS release, produced by THIS run, from THESE events.
 *
 * `digest` itself is excluded, obviously. Anything added here must also be
 * added to tests/sentry-receipt.test.ts, which edits each field in turn and
 * asserts the digest breaks.
 */
export const RECEIPT_BOUND_FIELDS = Object.freeze([
  'browserEventId',
  'browserSource',
  'environment',
  'nonce',
  'notBefore',
  'releaseSha',
  'serverEventId',
  'serverSource',
  'sourceMapsPublic',
  'verifiedAt',
]);

/**
 * HMAC over a canonical serialisation of the bound fields.
 *
 * Canonical means sorted keys and explicit types — otherwise two receipts that
 * say the same thing in a different key order would digest differently, and a
 * round trip through JSON would look like tampering.
 */
export function receiptDigest(secret, receipt) {
  const canonical = RECEIPT_BOUND_FIELDS.map(
    (k) => `${k}=${JSON.stringify(receipt?.[k] ?? null)}`,
  ).join('\n');
  return createHmac('sha256', String(secret)).update(canonical).digest('hex');
}

/**
 * Is this receipt intact, and does it assert something acceptable?
 *
 * Returns a reason rather than a bare boolean so a failing soak tick can say
 * which it was, without echoing the receipt.
 */
export function verifyReceiptIntegrity(secret, receipt) {
  if (!receipt || typeof receipt !== 'object') {
    return { ok: false, reason: 'no receipt' };
  }
  if (typeof receipt.digest !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.digest)) {
    return { ok: false, reason: 'the receipt carries no digest — it cannot be trusted' };
  }
  const expected = Buffer.from(receiptDigest(secret, receipt), 'hex');
  const actual = Buffer.from(receipt.digest, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return {
      ok: false,
      reason: 'the receipt digest does not match its contents — it was edited after signing',
    };
  }
  // Signed correctly and still unacceptable: a release that serves its own
  // source maps publicly is not fit to soak, and the receipt is an assertion
  // that it is.
  if (receipt.sourceMapsPublic !== false) {
    return {
      ok: false,
      reason:
        'the receipt does not affirmatively record that source maps are unavailable publicly ' +
        `(sourceMapsPublic=${JSON.stringify(receipt.sourceMapsPublic)}); this check fails ` +
        'closed, so "unknown" is a failure',
    };
  }
  return { ok: true };
}

/**
 * The file each runtime's probe throws from.
 *
 * Required, not merely preferred. Symbolication used to be satisfied by ANY
 * `.ts`/`.tsx` frame with context — so a middleware file, a library helper, or
 * anything else that happened to resolve would prove "source maps work" while
 * the probe's own frame stayed minified. The claim being made is that THIS
 * stack is readable, and the only way to check that is to name the file.
 */
export const PROBE_SOURCES = Object.freeze({
  server: 'app/api/health/sentry-probe/route.ts',
  browser: 'app/probe/sentry/BrowserProbe.tsx',
});

/** Every frame of every exception in the event, flattened. */
function framesOf(event) {
  return (
    event?.entries
      ?.filter((e) => e.type === 'exception')
      .flatMap((e) => e.data?.values ?? [])
      .flatMap((v) => v.stacktrace?.frames ?? []) ?? []
  );
}

/**
 * Is this frame ORIGINAL REPOSITORY SOURCE, resolved through a source map?
 *
 * An allow-list, not a deny-list. A deny-list of build-output shapes has to be
 * complete to be correct, and build tools invent new ones. An earlier version
 * excluded only `/_next/static/chunks/` and `.min.js`, so a SERVER build
 * artefact — `.next/server/app/api/.../route.js` — with context lines counted
 * as original source.
 */
function isOriginalSource(f) {
  if (!Array.isArray(f?.context) || f.context.length === 0) return false;
  const name = typeof f.filename === 'string' ? f.filename : '';
  if (!name) return false;
  if (!/\.tsx?$/.test(name)) return false;
  // A dependency's own source map is not proof that ours were uploaded.
  if (/(^|\/)node_modules\//.test(name)) return false;
  // Belt and braces: nothing under a build directory, whatever its extension.
  if (/(^|\/)\.next\//.test(name)) return false;
  if (/^webpack-internal:/.test(name)) return false;
  return true;
}

/**
 * Does the event carry a readable frame from the KNOWN probe source for this
 * runtime?
 *
 * `expectedSource` may be omitted, in which case any original-source frame
 * counts — kept only so the older call shape keeps working; every caller in
 * this repository passes one.
 */
export function isSymbolicated(event, expectedSource) {
  const original = framesOf(event).filter(isOriginalSource);
  if (original.length === 0) return false;
  if (!expectedSource) return true;
  // Suffix match: Sentry may report the path with or without a leading slash
  // or a project-root prefix, depending on how the maps were uploaded.
  return original.some((f) => String(f.filename).replace(/^\/+/, '').endsWith(expectedSource));
}

/** Which original-source files the event's stack actually resolved to. */
export function symbolicatedSources(event) {
  return [
    ...new Set(
      framesOf(event)
        .filter(isOriginalSource)
        .map((f) => String(f.filename)),
    ),
  ];
}

/**
 * Check one Sentry event against what this verification run actually emitted.
 *
 * Every clause exists because its absence let something through: without the
 * nonce an old event passes; without `notBefore` a cached one does; without
 * the runtime tag the same event satisfies both server and browser; without
 * release and environment an event from staging or a previous deploy counts.
 */
export function verifyReceipt(event, expect) {
  const problems = [];
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
    problems.push(
      `environment is ${event.environment ?? '(none)'}, expected ${expect.environment}`,
    );
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

  // The expected source is derived from the runtime, so a caller cannot
  // accidentally check the browser probe's file against a server event.
  const expectedSource = PROBE_SOURCES[expect.runtime];
  const symbolicated = isSymbolicated(event, expectedSource);
  const sources = symbolicatedSources(event);
  if (!symbolicated) {
    problems.push(
      sources.length === 0
        ? 'no frame resolved to original repository source — the stack is unreadable minified output'
        : `no frame resolved to ${expectedSource}; readable frames were: ${sources.join(', ')}`,
    );
  }
  return { ok: problems.length === 0, eventId, symbolicated, sources, problems };
}

/**
 * Both runtimes together, which is what the soak's observability gate needs.
 *
 * Requires distinct event ids: emitting once through the Node SDK and reusing
 * the id for both fields is exactly what the previous implementation did.
 */
export function verifyReceiptPair(input) {
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
  // EACH runtime proves its own. This was `server.symbolicated ||
  // browser.symbolicated`, so uploading server maps alone satisfied the gate
  // while every browser stack stayed minified — and the browser is where
  // minification actually hurts. They are separate uploads, separate maps and
  // separate failure modes; one cannot vouch for the other.
  if (!input.server.symbolicated) {
    problems.push(
      'server: no stack frame resolved to original repository source — server stacks are ' +
        'unreadable compiled output, which is a subtler way of having no Sentry at all',
    );
  }
  if (!input.browser.symbolicated) {
    problems.push(
      'browser: no stack frame resolved to original repository source — browser stacks are ' +
        'unreadable minified frames',
    );
  }
  const symbolicated = input.server.symbolicated && input.browser.symbolicated;
  return { ok: problems.length === 0, problems, symbolicated };
}
