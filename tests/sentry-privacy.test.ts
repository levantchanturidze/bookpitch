import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEvent, EventHint, NodeOptions } from '@sentry/nextjs';
import { scrubSentryEvent } from '@/lib/scrub';

// Synthetic markers only. The SDK transport below is an in-memory sink: no
// production DSN, patient data, account credentials, or network requests.
const EMAIL = 'privacy-canary@example.invalid';
const PHONE = '+995555012345';
const BEARER = 'BearerCanary012345678901234567890123456';
const PASSWORD = 'ConnectionPasswordCanary';
const QUERY = 'QueryValueCanary';
const FRAGMENT = 'FragmentValueCanary';
const REQUEST_BODY = 'RequestBodyCanary';
const HEADER = 'HeaderCanary';
const COOKIE = 'CookieCanary';
const LOCAL = 'StackLocalCanary';
const SENTRY_TOKEN = ['sntrys_', 'SyntheticCanary+Private/Suffix='].join('');
const NONCE = 'probe_4cbdd7c1_96d0_4b98_879b_1e61a2d140d0';
const RELEASE = 'b04d3ce2eb1222c826e35fcc1c46fa5f8a076885';
const EVENT_ID = '68cefc7741a34298956edc6cc4e51420';
const DEBUG_ID = '461b954a-abbb-4243-bb46-f797cb0e2fbc';
const CANARIES = [
  EMAIL,
  PHONE,
  BEARER,
  PASSWORD,
  QUERY,
  FRAGMENT,
  REQUEST_BODY,
  HEADER,
  COOKIE,
  LOCAL,
  'SyntheticCanary',
  'Private/Suffix',
];

function eventFixture(): ErrorEvent {
  return {
    type: undefined,
    event_id: EVENT_ID,
    level: 'error',
    platform: 'javascript',
    release: RELEASE,
    environment: 'production',
    message: `Provider rejected ${EMAIL}, SMS ${PHONE}, auth Bearer ${BEARER}; ${SENTRY_TOKEN}`,
    logentry: { message: `Delivery failed for ${EMAIL}`, params: [EMAIL, PHONE] },
    exception: {
      values: [
        {
          type: 'BookpitchSentryProbeError',
          value: `Connect failed: postgresql://bookpitch:${PASSWORD}@db.example.invalid/main`,
          mechanism: { type: 'generic', handled: true },
          stacktrace: {
            frames: [
              {
                filename: 'app/api/health/sentry-probe/route.ts',
                abs_path: `https://bookpitch.example.invalid/_next/static/probe.js?token=${QUERY}#${FRAGMENT}`,
                function: 'POST',
                lineno: 88,
                colno: 19,
                in_app: true,
                vars: { opaque: LOCAL },
              },
            ],
          },
        },
      ],
    },
    tags: {
      bookpitch_verification_nonce: NONCE,
      bookpitch_runtime: 'server',
      bookpitch_probe: 'true',
    },
    extra: {
      release: RELEASE,
      providerResponse: `Rejected recipient ${EMAIL} with phone ${PHONE}`,
      url: encodeURIComponent(`/customers?private=${QUERY}#${FRAGMENT}`),
      email: EMAIL,
    },
    contexts: {
      navigation: {
        url: `/customers?private=${QUERY}#${FRAGMENT}`,
        upstream: `https://user:${PASSWORD}@example.invalid/path?session=${QUERY}#${FRAGMENT}`,
      },
    },
    request: {
      method: 'POST',
      url: `https://bookpitch.example.invalid/api/appointments?private=${QUERY}#${FRAGMENT}`,
      data: { arbitrary: REQUEST_BODY },
      headers: { 'X-Custom-Header': HEADER },
      cookies: { session: COOKIE },
      query_string: `private=${QUERY}`,
      env: { custom: REQUEST_BODY },
    },
    user: { id: 'UserIdentityCanary', email: EMAIL, ip_address: '203.0.113.61' },
    breadcrumbs: [
      {
        category: 'console',
        message: `Patient contact ${EMAIL} ${PHONE}`,
        data: { arguments: [`upstream Bearer ${BEARER}`] },
      },
      {
        category: 'navigation',
        data: { from: `/signin?state=${QUERY}`, to: `/home#${FRAGMENT}` },
      },
    ],
    debug_meta: {
      images: [{ type: 'sourcemap', debug_id: DEBUG_ID, code_file: '/_next/static/probe.js' }],
    },
    sdk: { name: 'sentry.javascript.nextjs', version: '10.67.0' },
  } as ErrorEvent;
}

function expectNoCanaries(serialized: string) {
  // Check both literal and URL-encoded forms. A change in encoding is not a
  // privacy fix; the receiving system can decode the same envelope.
  for (const canary of CANARIES) {
    expect(serialized, `literal ${canary} escaped`).not.toContain(canary);
    expect(serialized, `encoded ${canary} escaped`).not.toContain(encodeURIComponent(canary));
  }
}

function expectProbeMetadata(event: ErrorEvent) {
  expect(event.event_id).toBe(EVENT_ID);
  expect(event.release).toBe(RELEASE);
  expect(event.environment).toBe('production');
  expect(event.tags).toMatchObject({
    bookpitch_verification_nonce: NONCE,
    bookpitch_runtime: 'server',
    bookpitch_probe: 'true',
  });
  expect(event.extra?.release).toBe(RELEASE);
  expect(event.debug_meta?.images?.[0]).toMatchObject({
    debug_id: DEBUG_ID,
    code_file: '/_next/static/probe.js',
  });
  expect(event.exception?.values?.[0]).toMatchObject({
    type: 'BookpitchSentryProbeError',
    mechanism: { type: 'generic', handled: true },
  });
  expect(event.exception?.values?.[0].stacktrace?.frames?.[0]).toMatchObject({
    filename: 'app/api/health/sentry-probe/route.ts',
    function: 'POST',
    lineno: 88,
    colno: 19,
    in_app: true,
  });
}

function freezeDeep(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const nested of Object.values(value)) freezeDeep(nested);
}

describe('Sentry error-envelope privacy boundary', () => {
  it('removes realistic serialized canaries while retaining verifier and source-map identity', () => {
    const raw = eventFixture();
    // Complement: these assertions would not be meaningful with an already
    // clean fixture. The old scrubSensitive-only path leaks these values.
    for (const marker of CANARIES) expect(JSON.stringify(raw)).toContain(marker);
    const clean = scrubSentryEvent(raw);
    expect(clean).not.toBeNull();
    expectNoCanaries(JSON.stringify(clean));
    expectProbeMetadata(clean!);
    expect(clean!.user).toBeUndefined();
    expect(clean!.request).toEqual({
      method: 'POST',
      url: 'https://bookpitch.example.invalid/api/appointments',
    });
    expect(clean!.exception?.values?.[0].stacktrace?.frames?.[0].vars).toBeUndefined();
  });

  it('does not mutate frozen input or nested arrays', () => {
    const raw = eventFixture();
    const before = JSON.stringify(raw);
    freezeDeep(raw);
    const clean = scrubSentryEvent(raw);
    expect(clean).not.toBeNull();
    expect(clean).not.toBe(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expectNoCanaries(JSON.stringify(clean));
  });

  it.each([
    `https://user:${PASSWORD}@example.invalid/path?private=${QUERY}#${FRAGMENT}`,
    `/reset-password?code=${QUERY}#${FRAGMENT}`,
    encodeURIComponent(`https://example.invalid/path?private=${QUERY}#${FRAGMENT}`),
    encodeURIComponent(`/reset-password?code=${QUERY}#${FRAGMENT}`),
    `https://user:${PASSWORD}@[invalid?private=${QUERY}#${FRAGMENT}`,
  ])('strips userinfo, query and fragments, including encoded or malformed URL: %s', (url) => {
    const clean = scrubSentryEvent({ event_id: EVENT_ID, extra: { url } });
    expect(clean).not.toBeNull();
    expectNoCanaries(JSON.stringify(clean));
    expect(clean!.event_id).toBe(EVENT_ID);
  });

  it('bounds cycles, deeply nested values and large strings/arrays without losing event identity', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const circularArray: unknown[] = [];
    circularArray.push(circularArray);
    let deep: unknown = { email: EMAIL };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    const clean = scrubSentryEvent({
      event_id: EVENT_ID,
      extra: {
        cycle,
        circularArray,
        deep,
        long: 'x'.repeat(100_000),
        many: Array(500).fill(EMAIL),
      },
    });
    expect(clean).not.toBeNull();
    expect(clean!.event_id).toBe(EVENT_ID);
    const serialized = JSON.stringify(clean);
    expect(serialized.length).toBeLessThan(20_000);
    expect(serialized).not.toContain(EMAIL);
    expect(cycle.self).toBe(cycle);
    expect(circularArray[0]).toBe(circularArray);
  });

  it('fails safely for absent input and hostile property access', () => {
    expect(scrubSentryEvent(null)).toBeNull();
    const hostile = Object.defineProperty({ event_id: EVENT_ID }, 'request', {
      enumerable: true,
      get() {
        throw new Error(EMAIL);
      },
    });
    expect(() => scrubSentryEvent(hostile)).not.toThrow();
    expect(JSON.stringify(scrubSentryEvent(hostile))).not.toContain(EMAIL);
  });
});

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ init }));

const CONFIGS = [
  ['server', () => import('../sentry.server.config')],
  ['browser', () => import('../sentry.client.config')],
  ['edge', () => import('../sentry.edge.config')],
] as const;

async function configuredOptions(load: () => Promise<unknown>): Promise<NodeOptions> {
  vi.resetModules();
  init.mockClear();
  vi.stubEnv('SENTRY_DSN', 'https://public@example.invalid/1');
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://public@example.invalid/1');
  // The old optional knobs must not silently turn on a second, unsanitized
  // egress channel. Re-enabling tracing requires an explicit reviewed change.
  vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '1');
  vi.stubEnv('SENTRY_EDGE_TRACES_SAMPLE_RATE', '1');
  vi.stubEnv('NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE', '1');
  await load();
  expect(init).toHaveBeenCalledTimes(1);
  return init.mock.calls[0][0] as NodeOptions;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the actual runtime configs enforce the boundary', () => {
  it.each(CONFIGS)(
    '%s passes scrubbed events to its installed beforeSend callback',
    async (_runtime, load) => {
      const options = await configuredOptions(load);
      expect(options.beforeSend).toBeTypeOf('function');
      const clean = await options.beforeSend!(eventFixture(), {} as EventHint);
      expect(clean).not.toBeNull();
      expectNoCanaries(JSON.stringify(clean));
      expectProbeMetadata(clean!);
      expect(options.sendDefaultPii).toBe(false);
      expect(options.tracesSampleRate).toBe(0);
      expect(options.enableLogs).toBe(false);
      if (_runtime === 'browser') {
        expect(options).toMatchObject({ replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0 });
      }
    },
  );

  it('the real SDK capture/serialization pipeline sends only the scrubbed event to a local sink', async () => {
    const options = await configuredOptions(CONFIGS[0][1]);
    // Import the actual installed SDK despite the init spy above. A dedicated
    // client with no integrations cannot hook global fetch/HTTP or open a
    // network transport; send() below is the entire transport implementation.
    const sdk = await vi.importActual<typeof import('@sentry/nextjs')>('@sentry/nextjs');
    const wires: string[] = [];
    const client = new sdk.NodeClient({
      dsn: 'https://public@example.invalid/1',
      release: RELEASE,
      environment: 'production',
      integrations: [],
      stackParser: sdk.defaultStackParser,
      sendClientReports: false,
      sendDefaultPii: false,
      beforeSend: options.beforeSend,
      transport: () => ({
        send: async (envelope) => {
          // These are the event payloads supplied to the SDK transport, not
          // an independently scrubbed copy or a source-text wiring assertion.
          wires.push(JSON.stringify(envelope));
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });
    client.init();
    try {
      client.captureEvent(eventFixture());
      const scope = new sdk.Scope();
      scope.setTags({ bookpitch_verification_nonce: NONCE, bookpitch_runtime: 'server' });
      scope.setExtra('release', RELEASE);
      client.captureException(new Error(`Synthetic SDK error for ${EMAIL} at ${PHONE}`), {}, scope);
      expect(await client.flush(2_000)).toBe(true);
      expect(wires).toHaveLength(2);
      for (const wire of wires) {
        expectNoCanaries(wire);
        expect(wire).toContain(NONCE);
        expect(wire).toContain(RELEASE);
      }
      const fixtureEnvelope = JSON.parse(wires[0]) as [unknown, Array<[unknown, ErrorEvent]>];
      expectProbeMetadata(fixtureEnvelope[1][0][1]);
      expect(fixtureEnvelope[1][0][1].user).toBeUndefined();
      expect(fixtureEnvelope[1][0][1].request?.headers).toBeUndefined();
    } finally {
      await client.close(2_000);
    }
  });
});
