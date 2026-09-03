#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Prove, level by level, how far Sentry actually gets — in the DEPLOYED
// application, in BOTH runtimes.
//
//   APP_URL=… CRON_SECRET=… SENTRY_AUTH_TOKEN=… SENTRY_ORG=… SENTRY_PROJECT=… \
//     npm run verify:sentry
//
// ---------------------------------------------------------------------------
// What the previous version proved, and why it was not enough.
//
// It imported @sentry/node ON THIS MACHINE, called init() with a DSN from the
// local environment, and posted a hand-built envelope to Sentry's ingest. Every
// level it reported was about a laptop:
//
//   * it never contacted the deployment, so a production build with no DSN
//     passed;
//   * it used the Node SDK for what it labelled the browser event, so
//     NEXT_PUBLIC_SENTRY_DSN, the browser transport and the browser source maps
//     were never exercised at all;
//   * the envelope carried a message and no exception, so there was no stack —
//     and symbolication, the thing source maps exist for, could not be observed
//     even in principle;
//   * the receipt it wrote named one event and took the runtime from an
//     environment variable, so "which SDK produced this" was a claim.
//
// This version makes the deployed application emit both events:
//
//   server   POST /api/health/sentry-probe        (bearer CRON_SECRET)
//   browser  GET  /probe/sentry?nonce&token&exp   (real Chromium, real bundle)
//
// Both carry the same freshly generated nonce, so the events can be proven to
// belong to THIS run, and both throw a real Error, so both have a real stack.
//
// ---------------------------------------------------------------------------
// The ladder. Each level is a claim the one below it does not support.
//
//   1 CONFIGURED   the deployment answers, and reports a DSN for the runtime
//   2 INITIALISED  the deployed SDK produced a client
//   3 EMITTED      captureException returned an id AND the transport drained
//   4 INDEXED      the event is retrievable through the Sentry API
//   5 VERIFIED     the retrieved events are THIS run's — matching nonce,
//                  release, environment and runtime tag, two distinct ids, and
//                  original-source frames on BOTH
//
// Only level 5 means an error would reach a human in a readable form. Levels
// 1-3 all pass against a valid DSN for a project that does not exist. Level 4
// passes on an event whose stack is unreadable minified chunks.
//
// Plus one check that is not a level, because it is about what must NOT be
// true: source maps must be uploaded to Sentry and absent from the CDN.
//
// Never prints the DSN, the auth token, CRON_SECRET, or the probe URL (which
// carries the authorisation token). Nonce and event ids only — both are public
// correlation identifiers.
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { verifyReceipt, verifyReceiptPair } from './sentry-receipt.mjs';

const results = [];
function record(level, name, ok, detail) {
  results.push({ level, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${level}. ${name}${detail ? ` — ${detail}` : ''}`);
}
function note(text) {
  console.log(`      ${text}`);
}
function bail(message) {
  console.log(`\n${message}`);
  console.log('\nHighest level proven: 0 (NOTHING)');
  process.exit(1);
}

// ── Inputs ───────────────────────────────────────────────────────────────────
const APP_URL = (process.env.APP_URL ?? '').replace(/\/+$/, '');
const CRON_SECRET = process.env.CRON_SECRET ?? '';
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN ?? '';
const SENTRY_ORG = process.env.SENTRY_ORG ?? '';
const SENTRY_PROJECT = process.env.SENTRY_PROJECT ?? '';
const ENVIRONMENT = process.env.SENTRY_ENVIRONMENT ?? 'production';

const missing = Object.entries({
  APP_URL,
  CRON_SECRET,
  SENTRY_AUTH_TOKEN,
  SENTRY_ORG,
  SENTRY_PROJECT,
})
  .filter(([, v]) => !v.trim())
  .map(([k]) => k);
if (missing.length) {
  bail(
    `Cannot verify anything: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.\n` +
      'This script proves things about a DEPLOYMENT, so it needs the deployment\n' +
      'URL, the credential its probes require, and API access to read the events\n' +
      'back. Absence of any of them is not a partial pass.',
  );
}

// The freshness bound, captured BEFORE anything is emitted. 120 seconds of
// slack absorbs clock skew between this machine and Sentry's ingest; the nonce
// is what actually excludes older events, and it is unguessable.
const notBefore = new Date(Date.now() - 120_000);

const http = (url, init = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) });

// ── Which release are we talking about ───────────────────────────────────────
let releaseSha = null;
try {
  const res = await http(`${APP_URL}/api/health`);
  releaseSha = res.headers.get('x-bookpitch-release');
  if (!res.ok) bail(`${APP_URL}/api/health answered HTTP ${res.status}. Is the deployment live?`);
  if (!releaseSha) {
    bail(
      'The deployment does not send x-bookpitch-release. Without it a Sentry event\n' +
        'cannot be tied to the code that produced it, and the soak cannot tell a\n' +
        'receipt for this release from one for a release that is no longer running.',
    );
  }
  note(`deployed release ${releaseSha.slice(0, 12)}`);
} catch (err) {
  bail(`Could not reach ${APP_URL}/api/health: ${err.message}`);
}

// ── Authorisation for the browser probe ──────────────────────────────────────
// The nonce is minted server-side so this run cannot be handed one that already
// has matching events sitting in Sentry from an earlier run.
let probeAuth = null;
try {
  const res = await http(`${APP_URL}/api/health/sentry-probe/token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  if (res.status === 404) {
    bail(
      'The probe is disabled on this deployment (SENTRY_PROBE_ENABLED is not "true").\n' +
        'Enable it for the verification window and turn it off afterwards.',
    );
  }
  if (res.status === 401) bail('The deployment rejected CRON_SECRET.');
  if (!res.ok) bail(`Probe token endpoint answered HTTP ${res.status}.`);
  probeAuth = await res.json();
  if (!probeAuth?.nonce || !probeAuth?.token || !probeAuth?.expiresAt) {
    bail('Probe token endpoint returned an unusable response.');
  }
  note(`verification nonce ${probeAuth.nonce}`);
} catch (err) {
  bail(`Could not obtain a probe token: ${err.message}`);
}

// ── SERVER runtime: levels 1-3 ───────────────────────────────────────────────
let serverEventId = null;
try {
  const res = await http(`${APP_URL}/api/health/sentry-probe`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: probeAuth.nonce }),
    timeoutMs: 30_000,
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 503) {
    record(1, 'CONFIGURED (server)', false, 'the deployment reports no SENTRY_DSN');
    record(2, 'INITIALISED (server)', false, 'no DSN, so Sentry.init() never ran');
    record(3, 'EMITTED (server)', false, 'nothing to emit');
  } else if (!res.ok) {
    record(1, 'CONFIGURED (server)', false, `probe answered HTTP ${res.status}`);
  } else {
    record(1, 'CONFIGURED (server)', true, 'the deployment reports a server DSN');
    record(
      2,
      'INITIALISED (server)',
      Boolean(body.eventId),
      body.eventId ? 'captureException returned an id' : 'no event id — the SDK is inert',
    );
    record(
      3,
      'EMITTED (server)',
      Boolean(body.eventId) && body.flushed === true,
      body.flushed === true
        ? `event ${body.eventId}, transport drained`
        : 'flush() timed out — the event may never have left the function',
    );
    if (body.eventId && body.flushed === true) serverEventId = body.eventId;
  }
} catch (err) {
  record(1, 'CONFIGURED (server)', false, `probe request failed: ${err.message}`);
}

// ── BROWSER runtime: levels 1-3, in a real browser ───────────────────────────
// A headless Chromium loading the deployed page is the only thing that
// exercises NEXT_PUBLIC_SENTRY_DSN, the browser bundle and the browser
// transport. Nothing runnable from Node can stand in for it.
let browserEventId = null;
{
  let browser = null;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
    });

    const url =
      `${APP_URL}/probe/sentry?nonce=${encodeURIComponent(probeAuth.nonce)}` +
      `&token=${encodeURIComponent(probeAuth.token)}&exp=${probeAuth.expiresAt}`;
    // Never logged: it carries the authorisation token.
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    if (!res || res.status() === 404) {
      record(
        1,
        'CONFIGURED (browser)',
        false,
        'the probe page 404s — probe disabled, or the token was refused',
      );
    } else {
      const el = page.locator('#probe-status');
      await el.waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});
      // The page reports through the DOM rather than the console, because a
      // console line is not a signal that can be awaited reliably.
      await page
        .waitForFunction(
          () => document.querySelector('#probe-status')?.dataset.status !== 'pending',
          { timeout: 30_000 },
        )
        .catch(() => {});

      const status = await el.getAttribute('data-status').catch(() => null);
      const id = await el.getAttribute('data-event-id').catch(() => null);

      record(
        1,
        'CONFIGURED (browser)',
        status !== 'no-client',
        status === 'no-client'
          ? 'the browser bundle initialised no Sentry client — NEXT_PUBLIC_SENTRY_DSN was ' +
              'absent at BUILD time (it is inlined, not read at runtime)'
          : 'the browser bundle reports a client',
      );
      record(
        2,
        'INITIALISED (browser)',
        Boolean(id),
        id ? 'captureException returned an id' : 'no event id',
      );
      record(
        3,
        'EMITTED (browser)',
        status === 'ok' && Boolean(id),
        status === 'ok'
          ? `event ${id}, transport drained`
          : `probe status "${status ?? 'unknown'}"`,
      );
      if (status === 'ok' && id) browserEventId = id;
      if (consoleErrors.length) note(`browser console errors: ${consoleErrors.length}`);
    }
  } catch (err) {
    record(
      1,
      'CONFIGURED (browser)',
      false,
      `could not drive a browser: ${err.message.split('\n')[0]}`,
    );
    note('Install browsers with: npm run e2e:install');
  } finally {
    await browser?.close().catch(() => {});
  }
}

// ── 4. INDEXED ───────────────────────────────────────────────────────────────
// Accepted by ingest is not visible to a human. Sentry answers 200 to envelopes
// it then drops on a quota, an inbound filter or a project rule. This reads the
// events back through the API, which is the first point at which "an error
// would reach a human" is true at all.
const sentryEvent = async (id) => {
  if (!id) return null;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const res = await http(
        `https://sentry.io/api/0/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/events/${id}/`,
        { headers: { authorization: `Bearer ${SENTRY_AUTH_TOKEN}` } },
      );
      if (res.ok) return await res.json();
      if (res.status === 401 || res.status === 403) {
        note(`Sentry API refused the token (HTTP ${res.status})`);
        return null;
      }
    } catch {
      /* retried below */
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return null;
};

const [serverEvent, browserEvent] = await Promise.all([
  sentryEvent(serverEventId),
  sentryEvent(browserEventId),
]);
record(
  4,
  'INDEXED',
  Boolean(serverEvent) && Boolean(browserEvent),
  `server ${serverEvent ? 'retrievable' : 'NOT retrievable'}, ` +
    `browser ${browserEvent ? 'retrievable' : 'NOT retrievable'}` +
    (serverEvent && browserEvent ? '' : ' — check quota, inbound filters and project rules'),
);

// ── 5. VERIFIED ──────────────────────────────────────────────────────────────
// Retrievable is still not evidence. The event has to be THIS run's, from THIS
// release, from the runtime it claims, and readable.
const expectation = { releaseSha, environment: ENVIRONMENT, nonce: probeAuth.nonce, notBefore };
const server = verifyReceipt(serverEvent, { ...expectation, runtime: 'server' });
const browser = verifyReceipt(browserEvent, { ...expectation, runtime: 'browser' });
const pair = verifyReceiptPair({ server, browser });
record(5, 'VERIFIED', pair.ok, pair.ok ? 'both events are this run’s, and readable' : '');
for (const p of pair.problems) note(`· ${p}`);

// ── Not a level: source maps must be on Sentry and NOT on the CDN ────────────
// `deleteSourcemapsAfterUpload` is a build option, and a build option is a
// claim until someone checks the deployed output. Symbolication above proves
// the maps reached Sentry; this proves they did not also reach the public.
try {
  const html = await (await http(APP_URL)).text();
  const chunk = /\/_next\/static\/chunks\/[A-Za-z0-9._-]+\.js/.exec(html)?.[0];
  if (!chunk) {
    note('source-map exposure: no chunk reference found on the landing page — not checked');
  } else {
    const js = await (await http(`${APP_URL}${chunk}`)).text();
    const ref = /\/\/# sourceMappingURL=(\S+)/.exec(js)?.[1];
    if (!ref) {
      record(0, 'SOURCE MAPS NOT PUBLIC', true, 'no sourceMappingURL in the served bundle');
    } else {
      const mapUrl = new URL(ref, `${APP_URL}${chunk}`).toString();
      const mapRes = await http(mapUrl, { method: 'GET' });
      record(
        0,
        'SOURCE MAPS NOT PUBLIC',
        !mapRes.ok,
        mapRes.ok
          ? `the .map is PUBLICLY READABLE (HTTP ${mapRes.status}) — the unminified ` +
              'application source is being served to anyone'
          : `the .map is not served (HTTP ${mapRes.status})`,
      );
    }
  }
} catch (err) {
  note(`source-map exposure check could not run: ${err.message}`);
}

// ── Receipt ──────────────────────────────────────────────────────────────────
// Written only on a complete pass. A partial receipt is worse than none: the
// soak would seed it, and the first tick would report a production fault for
// what is really an incomplete verification.
if (pair.ok && process.env.SENTRY_RECEIPT_OUT) {
  writeFileSync(
    process.env.SENTRY_RECEIPT_OUT,
    JSON.stringify(
      {
        // The freshness bound, deliberately the START of this run. Using the
        // finish time would make the receipt reject the very events it proved.
        notBefore: notBefore.toISOString(),
        verifiedAt: new Date().toISOString(),
        nonce: probeAuth.nonce,
        releaseSha,
        environment: ENVIRONMENT,
        serverEventId: server.eventId,
        browserEventId: browser.eventId,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\nreceipt written to ${process.env.SENTRY_RECEIPT_OUT}`);
  console.log('Pass it to the soak as SOAK_SENTRY_RECEIPT (or SOAK_SENTRY_RECEIPT_FILE).');
}

// ── Verdict ──────────────────────────────────────────────────────────────────
const levels = results.filter((r) => r.level > 0);
const highest = levels.filter((r) => r.ok).reduce((n, r) => Math.max(n, r.level), 0);
const firstFail = levels.find((r) => !r.ok)?.level ?? 6;
const proven = Math.min(highest, firstFail - 1);
const names = ['NOTHING', 'CONFIGURED', 'INITIALISED', 'EMITTED', 'INDEXED', 'VERIFIED'];
console.log(`\nHighest level proven: ${proven} (${names[proven]})`);

const exposed = results.find((r) => r.level === 0 && !r.ok);
if (proven < 5 || exposed) {
  console.log('\nSentry is NOT proven operational. Do not record it as verified,');
  console.log('and do not start the soak: its observability gate reads this receipt.');
  process.exit(1);
}
console.log('Sentry is proven end to end, in both runtimes, for this release.');
