#!/usr/bin/env node
// -----------------------------------------------------------------------------
// P17-007 — prove, level by level, how far Sentry actually gets.
//
//   npm run verify:sentry            # uses SENTRY_DSN from the environment
//   SENTRY_DSN=… npm run verify:sentry
//
// "Sentry is set up" is five different claims, and Phase 16 found production
// satisfying none of them while looking like it satisfied all of them — the SDK
// installed, config files present, instrumentation.ts exporting onRequestError,
// SENTRY_ENVIRONMENT set, and no DSN anywhere. This script refuses to collapse
// them:
//
//   1 CONFIGURED   a DSN exists and parses
//   2 INITIALISED  Sentry.init() produced a client
//   3 EMITTED      captureException produced an event id and the SDK flushed it
//   4 RECEIVED     Sentry's ingest endpoint accepted an envelope (HTTP 200 +
//                  an event id in the response body)
//   5 INDEXED      the event is retrievable through the Sentry API
//
// Only level 5 is evidence that an error would reach a human.
//
//   1–3 all pass against a syntactically valid DSN pointing at a project that
//       does not exist.
//   4   proves the envelope was well-formed. Sentry answers 200 to envelopes it
//       then drops on a quota, an inbound filter or a project rule, and the id
//       in the response is the one the CLIENT generated — so a 200 with an id
//       is not proof anything was stored.
//
// With SENTRY_RECEIPT_OUT set, a verified level-5 id is written to that path.
// The soak controller's observability gate reads those ids and re-checks them
// against the Sentry API; it previously read a boolean an operator ticked in a
// workflow form, which is a claim rather than evidence.
//
// Deliberately a script and not an endpoint. §12 allows a temporary protected
// route, but the safest test route is the one that was never deployed: this
// adds no attack surface, nothing to forget to remove, and no way for a
// scanner to find it.
//
// Never prints the DSN, the public key, or the ingest host. Presence, project
// id and the returned event id only.
// -----------------------------------------------------------------------------
import { randomBytes } from 'node:crypto';

const results = [];
function record(level, name, ok, detail) {
  results.push({ level, name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${level}. ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── 1. CONFIGURED ────────────────────────────────────────────────────────────
const dsn = process.env.SENTRY_DSN ?? '';
if (!dsn.trim()) {
  record(1, 'CONFIGURED', false, 'SENTRY_DSN is not set in this environment');
  console.log('\nNothing further can be proven without a DSN.');
  console.log('External action required: create the Sentry project, then set');
  console.log('SENTRY_DSN (server) and NEXT_PUBLIC_SENTRY_DSN (browser).');
  process.exit(1);
}

let parsed;
try {
  const u = new URL(dsn);
  const projectId = u.pathname.replace(/^\//, '');
  if (!u.username || !projectId) throw new Error('missing public key or project id');
  parsed = {
    protocol: u.protocol.replace(':', ''),
    host: u.host,
    publicKey: u.username,
    projectId,
  };
  record(1, 'CONFIGURED', true, `DSN parses, project id ${projectId}`);
} catch (err) {
  record(1, 'CONFIGURED', false, `DSN is malformed: ${err.message}`);
  process.exit(1);
}

// ── 2. INITIALISED ───────────────────────────────────────────────────────────
let Sentry;
try {
  Sentry = await import('@sentry/node');
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? 'verification',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    defaultIntegrations: false,
  });
  const client = Sentry.getClient();
  record(
    2,
    'INITIALISED',
    Boolean(client),
    client ? 'a client exists' : 'init() produced no client',
  );
} catch (err) {
  record(2, 'INITIALISED', false, err.message);
}

// ── 3. EMITTED ───────────────────────────────────────────────────────────────
let emittedId = null;
try {
  emittedId = Sentry.captureException(
    new Error('Bookpitch Sentry verification — level 3, safe to ignore'),
  );
  const flushed = await Sentry.flush(8000);
  record(
    3,
    'EMITTED',
    Boolean(emittedId) && flushed,
    `event id ${emittedId ?? 'none'}, flush ${flushed ? 'drained' : 'timed out'}`,
  );
} catch (err) {
  record(3, 'EMITTED', false, err.message);
}

let acceptedEventId = null;

// ── 4. RECEIVED ──────────────────────────────────────────────────────────────
// A flushed queue is not an accepted event: the SDK drops transport errors on
// purpose so telemetry never breaks the app. Post one envelope by hand and read
// the status line, which is the only unambiguous answer.
try {
  const eventId = randomBytes(16).toString('hex');
  const endpoint =
    `${parsed.protocol}://${parsed.host}/api/${parsed.projectId}/envelope/` +
    `?sentry_key=${parsed.publicKey}&sentry_version=7`;

  const header = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() });
  const itemHeader = JSON.stringify({ type: 'event' });
  const payload = JSON.stringify({
    event_id: eventId,
    level: 'info',
    platform: 'node',
    environment: process.env.SENTRY_ENVIRONMENT ?? 'verification',
    logger: 'bookpitch.verify-sentry',
    message: {
      formatted:
        'Bookpitch Sentry ingestion check — level 4. Synthetic, safe to resolve or delete.',
    },
    tags: { verification: 'true' },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: `${header}\n${itemHeader}\n${payload}\n`,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await res.text().catch(() => '');
  let acceptedId = null;
  try {
    acceptedId = JSON.parse(bodyText).id ?? null;
  } catch {
    /* Sentry answers 200 with a JSON id; anything else is reported as-is. */
  }

  acceptedEventId = acceptedId;
  record(
    4,
    'RECEIVED',
    res.ok && Boolean(acceptedId),
    res.ok
      ? `ingest accepted, event id ${acceptedId ?? '(no id in response)'}`
      : `ingest returned HTTP ${res.status}`,
  );
} catch (err) {
  record(4, 'RECEIVED', false, err.name === 'AbortError' ? 'ingest timed out' : err.message);
}

// ── 5. INDEXED ───────────────────────────────────────────────────────────────
// Accepted by ingest is still not visible to a human. Sentry answers 200 to an
// envelope it then drops on a quota, an inbound filter, or a project-level
// rule, and the id it returns is the one the CLIENT generated — so a 200 with
// an id proves the request was well-formed, not that anything was stored.
//
// This reads the event back through the Sentry API, which is the first point
// at which "an error would reach a human" is actually true.
let indexedId = null;
try {
  const authToken = process.env.SENTRY_AUTH_TOKEN;
  const org = process.env.SENTRY_ORG;
  const project = process.env.SENTRY_PROJECT;
  if (!authToken || !org || !project) {
    record(
      5,
      'INDEXED',
      false,
      'SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT are required to read an event back',
    );
  } else if (!acceptedEventId) {
    record(5, 'INDEXED', false, 'no accepted event id from level 4 to look up');
  } else {
    // Indexing is not synchronous. Poll briefly rather than declaring failure
    // on the first miss.
    for (let attempt = 1; attempt <= 10; attempt++) {
      const res = await fetch(
        `https://sentry.io/api/0/projects/${org}/${project}/events/${acceptedEventId}/`,
        { headers: { authorization: `Bearer ${authToken}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (res.ok) {
        indexedId = acceptedEventId;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    record(
      5,
      'INDEXED',
      Boolean(indexedId),
      indexedId
        ? `event ${indexedId} is retrievable from ${org}/${project}`
        : `event was accepted but never became retrievable from ${org}/${project} — ` +
            'check quota, inbound filters and project rules',
    );
  }
} catch (err) {
  record(5, 'INDEXED', false, err.message);
}

// ── Persist, for the soak gate ───────────────────────────────────────────────
// The soak's observability gate reads these ids and re-verifies them against
// the Sentry API. It used to read a boolean an operator ticked in a workflow
// form, which is a claim rather than evidence.
if (indexedId && process.env.SENTRY_RECEIPT_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    process.env.SENTRY_RECEIPT_OUT,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        projectId: parsed.projectId,
        // Which runtime produced it. The soak requires BOTH a server and a
        // browser event, because they exercise different SDKs, different
        // transports and different source maps.
        runtime: process.env.SENTRY_VERIFY_RUNTIME ?? 'server',
        eventId: indexedId,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\nreceipt written to ${process.env.SENTRY_RECEIPT_OUT}`);
}

// ── Verdict ──────────────────────────────────────────────────────────────────
const highest = results.filter((r) => r.ok).reduce((n, r) => Math.max(n, r.level), 0);
const names = ['NOTHING', 'CONFIGURED', 'INITIALISED', 'EMITTED', 'RECEIVED', 'INDEXED'];
console.log(`\nHighest level proven: ${highest} (${names[highest]})`);
if (highest < 5) {
  console.log('Sentry is NOT proven operational. Do not record it as verified.');
  console.log('Only level 5 (INDEXED) means an error would actually reach a human:');
  console.log('  1-3 pass against a DSN pointing at a project that does not exist;');
  console.log('  4 proves the envelope was well-formed, not that it was stored.');
  process.exit(1);
}
console.log('Sentry ingestion is proven end to end, and the event is retrievable.');
