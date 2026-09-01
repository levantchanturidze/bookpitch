#!/usr/bin/env node
// -----------------------------------------------------------------------------
// P17-007 — prove, level by level, how far Sentry actually gets.
//
//   npm run verify:sentry            # uses SENTRY_DSN from the environment
//   SENTRY_DSN=… npm run verify:sentry
//
// "Sentry is set up" is four different claims, and Phase 16 found production
// satisfying none of them while looking like it satisfied all of them — the SDK
// installed, config files present, instrumentation.ts exporting onRequestError,
// SENTRY_ENVIRONMENT set, and no DSN anywhere. This script refuses to collapse
// the four:
//
//   1 CONFIGURED   a DSN exists and parses
//   2 INITIALISED  Sentry.init() produced a client
//   3 EMITTED      captureException produced an event id and the SDK flushed it
//   4 RECEIVED     Sentry's ingest endpoint accepted an envelope (HTTP 200 +
//                  an event id in the response body)
//
// Only level 4 is evidence that an error would reach a human. Levels 1–3 all
// pass against a syntactically valid DSN pointing at a project that does not
// exist.
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

// ── Verdict ──────────────────────────────────────────────────────────────────
const highest = results.filter((r) => r.ok).reduce((n, r) => Math.max(n, r.level), 0);
const names = ['NOTHING', 'CONFIGURED', 'INITIALISED', 'EMITTED', 'RECEIVED'];
console.log(`\nHighest level proven: ${highest} (${names[highest]})`);
if (highest < 4) {
  console.log('Sentry is NOT proven operational. Do not record it as verified.');
  process.exit(1);
}
console.log('Sentry ingestion is proven end to end.');
