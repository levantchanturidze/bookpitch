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

// -----------------------------------------------------------------------------
// Reading `environment` and `release` off a Sentry API event.
//
// THE DEFECT these two functions exist to fix. The verifier read
// `event.environment` and `event.release` as plain strings. Neither is that
// shape on the endpoint it actually calls —
// GET /projects/{org}/{project}/events/{id}/ — which documents:
//
//   * NO top-level `environment` at all. It is a row in the `tags` array.
//   * `release` as a Release OBJECT (`{version, dateCreated, commitCount, …}`),
//     not a string.
//
//   https://docs.sentry.io/api/events/retrieve-an-event-for-a-project/
//
// So against a correctly configured, correctly delivering project, level 5
// reported:
//
//   · server: environment is (none), expected production
//   · server: release is [object Object], expected c274409a217a
//
// Both events were genuinely this run's: the nonce tag matched, the runtime tag
// matched, the timestamps were fresh and BOTH stacks symbolicated to their own
// probe source. The verifier was wrong, not the pipeline — it reported a
// working Sentry as broken and refused to write a receipt, which is what kept
// the soak from ever starting.
//
// The unit tests did not catch it because their fixture was built from the
// shape the verifier assumed rather than the shape the API returns: a
// top-level `environment` string and a string `release`. A fixture that mirrors
// the code under test can only ever confirm it.
//
// Both readers still fail closed. An event carrying neither form returns null,
// which cannot equal an expected environment or a 40-character SHA, so the
// comparison in verifyReceipt() still rejects it.
// -----------------------------------------------------------------------------

/**
 * The environment an event was reported under, from either shape.
 *
 * @param {any} event a Sentry API event payload
 * @returns {string|null}
 */
export function eventEnvironment(event) {
  const top = event?.environment;
  if (typeof top === 'string' && top) return top;
  const tagged = tag(event ?? {}, 'environment');
  return typeof tagged === 'string' && tagged ? tagged : null;
}

/**
 * The release version an event was reported under, from either shape.
 *
 * A Release object is unwrapped to its `version`, which is the string the SDK
 * was configured with and the string this project compares against the SHA the
 * deployment serves in `x-bookpitch-release`.
 *
 * @param {any} event a Sentry API event payload
 * @returns {string|null}
 */
export function eventRelease(event) {
  const r = event?.release;
  if (typeof r === 'string' && r) return r;
  if (r && typeof r === 'object' && typeof r.version === 'string' && r.version) return r.version;
  const tagged = tag(event ?? {}, 'release');
  return typeof tagged === 'string' && tagged ? tagged : null;
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
  'sourceMapAssets',
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
 * What one source-map probe proved.
 *
 * The previous check called ANY non-2xx "not publicly served". That is wrong
 * for most of the ways a request fails: 429 means we were throttled, 5xx means
 * the CDN was unwell, a redirect to a login page means something intercepted
 * us, and a network error means we never asked. None of those is evidence that
 * the map is private — they are evidence that we do not know.
 *
 * Only an explicit "this is not here" counts. Everything else fails closed,
 * because the claim being made is a negative one, and a negative claim cannot
 * rest on a request that did not complete.
 *
 * @param {{status?: number, error?: string}} outcome
 * @returns {'private'|'exposed'|'indeterminate'}
 */
export function classifyMapProbe(outcome) {
  if (outcome?.error) return 'indeterminate';
  const status = outcome?.status;
  if (typeof status !== 'number') return 'indeterminate';
  if (status >= 200 && status < 300) return 'exposed';
  // The only two answers that mean "there is no such asset here".
  if (status === 404 || status === 410) return 'private';
  // 403 is still NOT private on its own, for exactly the reasons it never was:
  // a host that forbids us may serve the file to someone else, and some hosts
  // answer 403 when rate limiting. It is now its OWN classification rather than
  // a generic unknown, because it is the one unknown that corroborating
  // evidence can resolve — see summariseMapProbes(). Nothing about a lone 403
  // has been relaxed: `blocked` passes only with that evidence attached, and
  // fails closed without it.
  if (status === 403) return 'blocked';
  return 'indeterminate';
}

/**
 * Roll individual probe results into a verdict for the receipt.
 *
 * @param {Array<{url: string, classification: string}>} probes
 */
/**
 * What is MISSING from the control evidence offered for a 403, if anything.
 *
 * -----------------------------------------------------------------------------
 * Why this exists.
 *
 * Vercel refuses every `*.map` URL with a 403 and an empty body, whatever the
 * path and whether or not the file exists. Measured against production on
 * 2026-09-07, from one client in one moment:
 *
 *   /_next/static/immutable/chunks/16pnwa_au3un4.js          200   (648 bytes)
 *   /_next/static/immutable/chunks/16pnwa_au3un4.js.map      403   (empty)
 *   /_next/static/immutable/chunks/DOES-NOT-EXIST.js.map     403   (empty)
 *   /_next/static/immutable/chunks/DOES-NOT-EXIST.js         404
 *   /_next/static/immutable/chunks/16pnwa_au3un4.js.txt      404
 *   /foo/bar.js.map                                          403   (empty)
 *
 * So the refusal is scoped to the `.map` extension, not to the asset: a chunk
 * that CANNOT exist is refused identically, and the same chunk under a
 * different extension 404s. On a host that behaves this way the status code
 * carries no information about existence at all, and a check that demands a 404
 * can never go green — the gate would be permanently unsatisfiable, which is
 * this project's other failure mode and hides better than a false green.
 *
 * The fix is more evidence, not a lower bar. Two facts, gathered in the same
 * run against the same host, are what license reading a 403 as absence:
 *
 *   refusedNonexistent  a map URL that provably cannot exist was refused the
 *                       SAME way. If a fabricated path is refused identically,
 *                       the refusal is a blanket extension rule and says
 *                       nothing about any particular file — which is precisely
 *                       what makes it safe: no map is retrievable here.
 *
 *   servedSibling       a real asset in the same directory answered 200 to the
 *                       same client at the same time. This is what excludes the
 *                       two readings that would make a 403 alarming: we are not
 *                       being rate limited, and we are not behind an
 *                       authentication wall that would serve the file to
 *                       someone holding a credential.
 *
 * Either one alone is insufficient and is reported as such. Without the
 * fabricated-path control, a 403 on a real map could be an auth wall around
 * that one file. Without the served sibling, a blanket 403 could be a
 * deployment-wide block that would lift for an authorised requester.
 *
 * Note which way this fails. `null`/`undefined` control, a control that was not
 * attempted, or a control that came back with a different status all return a
 * reason, and a reason is a failure. Passing requires both facts to be
 * literally `true`.
 *
 * @param {{refusedNonexistent?: boolean|null, servedSibling?: boolean|null}} [control]
 * @returns {string|null} why the 403 is still unresolved, or null if it is not
 */
export function describeMissingMapControl(control) {
  const refused = control?.refusedNonexistent === true;
  const served = control?.servedSibling === true;
  if (refused && served) return null;
  const missing = [];
  if (!refused) {
    missing.push(
      'no fabricated map path was shown to be refused the same way, so the 403 has not been ' +
        'shown to be a blanket rule rather than a wall around this asset',
    );
  }
  if (!served) {
    missing.push(
      'no sibling asset was served 200 to the same client, so throttling and an ' +
        'authentication wall are not excluded',
    );
  }
  return `${missing.join('; ')}.`;
}

export function summariseMapProbes(probes, control) {
  if (!Array.isArray(probes) || probes.length === 0) {
    return {
      ok: false,
      sourceMapsPublic: null,
      problems: ['no source-map probe was performed — nothing was discovered to check'],
    };
  }
  const exposed = probes.filter((p) => p.classification === 'exposed');
  const blocked = probes.filter((p) => p.classification === 'blocked');
  const unknown = probes.filter((p) => p.classification === 'indeterminate');
  const problems = [];
  if (exposed.length) {
    problems.push(
      `publicly readable source map(s): ${exposed.map((p) => p.url).join(', ')} — the ` +
        'unminified application source is being served to anyone',
    );
  }
  if (blocked.length) {
    const missing = describeMissingMapControl(control);
    if (missing) {
      problems.push(
        `${blocked.length} map URL(s) were refused with 403 and nothing discriminates that ` +
          `refusal: ${blocked.map((p) => p.url).join(', ')}. ${missing} A bare 403 cannot ` +
          'tell "this host serves no map at any path" from "this map exists and we were ' +
          'forbidden it", so it fails closed',
      );
    }
  }
  if (unknown.length) {
    problems.push(
      `could not establish that ${unknown.length} map URL(s) are private: ` +
        `${unknown.map((p) => p.url).join(', ')}. This check fails closed, so "unknown" is a failure`,
    );
  }
  return {
    ok: problems.length === 0,
    sourceMapsPublic: exposed.length > 0 ? true : problems.length === 0 ? false : null,
    problems,
  };
}

// -----------------------------------------------------------------------------
// Classifying a verification run, honestly.
//
// The production monitor detects only that DSN variable NAMES are unset.
// Revoked, mistyped, filtered, quota-exhausted or wrong-project DSNs all leave
// that check green — so "errors reach a human" was never actually monitored,
// only "two strings exist".
//
// And a failed reverify exited before the controller, raised no incident, and
// outside an active soak did nothing at all: a production where delivery had
// silently stopped looked identical to one where it worked.
//
// Three failure states, deliberately distinct, because they need different
// responses and conflating them is how an operator learns to ignore the alarm.
// The distinction that matters most is the first one: not being able to check
// is not the same as having checked and found it broken, and claiming otherwise
// is the mirror image of claiming success on no evidence.
// -----------------------------------------------------------------------------

/** Strip anything that could identify a credential before it reaches an issue. */
function redact(text) {
  return (
    String(text ?? '')
      // Sentry DSNs carry a public key and the ingest host.
      .replace(/https?:\/\/[^@\s]+@[^\s/]+\/\d+/g, '[redacted DSN]')
      .replace(/\b[a-z]*\.?ingest\.[a-z.]*sentry\.io\S*/gi, '[redacted ingest host]')
      .replace(/\bsntrys_[A-Za-z0-9_-]+/g, '[redacted token]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/__Host-[A-Za-z0-9_-]+=?\S*/g, '[redacted cookie]')
  );
}

/**
 * What did this verification run establish?
 *
 * @param {{proven?: number, problems?: string[], missingInputs?: string[],
 *          mapVerdict?: {ok?: boolean, sourceMapsPublic?: boolean|null,
 *                        problems?: string[]}}} run
 * @returns {{state: 'verified'|'unavailable'|'indeterminate'|'broken',
 *            summary: string, problems: string[]}}
 */
export function classifyVerifierOutcome(run) {
  const problems = (run?.problems ?? []).map(redact);
  const joined = problems.join(' ');
  const map = run?.mapVerdict;

  // Could not be attempted at all: nothing is known, so nothing is claimed.
  if ((run?.missingInputs ?? []).length > 0) {
    return {
      state: 'unavailable',
      summary:
        'Sentry verification could not be attempted: required configuration is absent ' +
        `(${run.missingInputs.length} input(s) unset). Nothing is known about whether errors ` +
        'reach a human — this is not a report that delivery is broken.',
      problems,
    };
  }
  if (/reports no SENTRY_DSN|no DSN|DSN is not configured/i.test(joined)) {
    return {
      state: 'unavailable',
      summary:
        'Sentry verification could not be attempted: the deployment reports no DSN, so the SDK ' +
        'is inert and there is nothing to verify against.',
      problems,
    };
  }

  // Confirmed broken: something was emitted and demonstrably did not work.
  if (map?.sourceMapsPublic === true) {
    return {
      state: 'broken',
      summary:
        'CONFIRMED: source maps are publicly readable, so the unminified application source is ' +
        'being served to anyone.',
      problems,
    };
  }
  if (
    /NOT retrievable|never became retrievable|does not match|predates this verification/i.test(
      joined,
    )
  ) {
    return {
      state: 'broken',
      summary:
        'CONFIRMED: events were emitted by the deployed application and did not arrive usable. ' +
        'Errors are not reaching a human.',
      problems,
    };
  }

  // Started and could not finish.
  if (
    /refused the token|HTTP 4\d\d|HTTP 5\d\d|quota|rate limit|timed out|could not be determined|could not establish/i.test(
      joined,
    ) ||
    (map && map.ok === false && map.sourceMapsPublic !== true)
  ) {
    return {
      state: 'indeterminate',
      summary:
        'Sentry verification could not be completed. This is NOT a confirmed delivery failure ' +
        'and NOT a pass: the check started and could not finish, so the state of error ' +
        'reporting is unknown.',
      problems,
    };
  }

  if ((run?.proven ?? 0) >= 5 && problems.length === 0 && map?.ok === true) {
    return {
      state: 'verified',
      summary:
        'Sentry verified end to end: real events from the deployed application in both ' +
        'runtimes, read back and matched on release, environment, nonce and runtime, each ' +
        'stack resolved to its own probe source, public source maps affirmatively absent.',
      problems,
    };
  }

  return {
    state: 'indeterminate',
    summary:
      `Sentry verification reached level ${run?.proven ?? 0} of 5 without a clear cause. ` +
      'Treated as unknown rather than as either outcome.',
    problems,
  };
}

/** Only a complete pass may close the observability incident. */
export function shouldCloseObservabilityIncident(outcome) {
  return outcome?.state === 'verified';
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

  const environment = eventEnvironment(event);
  if (environment !== expect.environment) {
    problems.push(`environment is ${environment ?? '(none)'}, expected ${expect.environment}`);
  }
  const release = eventRelease(event);
  if (release !== expect.releaseSha) {
    problems.push(
      `release is ${release ? String(release).slice(0, 60) : '(none)'}, ` +
        `expected ${expect.releaseSha.slice(0, 12)}`,
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
