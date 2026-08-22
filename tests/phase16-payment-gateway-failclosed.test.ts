import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// The action's import chain reaches lib/payments/service.ts, which drags in
// @/auth. Same stubs the existing webhook test uses, for the same reason.
vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { getGateway } = await import('@/lib/payments/gateway');
const { MockGateway } = await import('@/lib/payments/gateways/mock');
const { BogGateway } = await import('@/lib/payments/gateways/bog');
const { approveAction, declineAction } = await import('@/app/dev/mock-gateway/pay/actions');
const { __assertSafeFetchTarget } = await import('./setup');
const { safeReturnPath } = await import('@/app/dev/mock-gateway/pay/return-path');

// -----------------------------------------------------------------------------
// F16-001. The mock payment gateway was reachable in production, two ways.
//
//   1. getGateway() resolved `PAYMENT_GATEWAY ?? 'mock'`, so an unset variable
//      selected MockGateway — the adapter that signs its own webhooks and
//      reports every payment as paid.
//   2. The mock hosted-payment-page server actions had no environment gate, and
//      POSTed a validly signed payload to a URL taken from a hidden form field.
//      Server actions are addressable by id, so the page's notFound() never
//      protected them.
//
// The first fix pinned that URL to APP_URL's origin. That was not enough: an
// allow-listed URL is still a URL taken from the client, and the pin only held
// outside production by accident of configuration. The request is now gone —
// the actions call MockGateway.verifyWebhook() and applyWebhook() in-process,
// the same two steps app/api/webhooks/payment/route.ts performs.
//
// No test here contacts a real address. The SSRF property is proved by asserting
// fetch is never called, not by attempting the forgery.
// -----------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Any outbound request from an action is a failure, so make one impossible
  // and observable at the same time.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('no server action may perform an outbound request');
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.unstubAllEnvs();
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/**
 * A well-formed UUID that cannot exist, so applyWebhook() reaches its
 * 'not_found' branch rather than failing on id syntax. Reaching that branch is
 * the proof the action got all the way to the shared business logic.
 */
const ABSENT_PAYMENT = {
  paymentId: '00000000-0000-4000-8000-000000000000',
  gatewayTxnId: 'p16-tx',
};

function enableMock() {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('PAYMENT_GATEWAY', 'mock');
  vi.stubEnv('PAYMENT_MOCK_SECRET', 'test-secret');
}

describe('F16-001 · getGateway() fails closed in production', () => {
  it('throws when PAYMENT_GATEWAY is unset in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_GATEWAY', '');
    expect(() => getGateway()).toThrow(/must be set in production/i);
  });

  it('throws when PAYMENT_GATEWAY is explicitly mock in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_GATEWAY', 'mock');
    expect(() => getGateway()).toThrow(/not permitted in production/i);
  });

  it('treats whitespace as unset rather than as a gateway name', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_GATEWAY', '   ');
    expect(() => getGateway()).toThrow(/must be set in production/i);
  });

  it('rejects an unknown gateway name in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_GATEWAY', 'definitely-not-a-gateway');
    expect(() => getGateway()).toThrow(/Unknown PAYMENT_GATEWAY/i);
  });

  it('rejects an unknown gateway name outside production too', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PAYMENT_GATEWAY', 'definitely-not-a-gateway');
    expect(() => getGateway()).toThrow(/Unknown PAYMENT_GATEWAY/i);
  });

  // Complement: the same inputs outside production must still work, or the fix
  // would have broken local development instead of securing production.
  it('still falls back to the mock adapter outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PAYMENT_GATEWAY', '');
    expect(getGateway()).toBeInstanceOf(MockGateway);
  });

  it('still honours an explicit mock outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PAYMENT_GATEWAY', 'mock');
    expect(getGateway()).toBeInstanceOf(MockGateway);
  });

  it('resolves a real gateway in production, unchanged', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_GATEWAY', 'bog');
    expect(getGateway()).toBeInstanceOf(BogGateway);
  });
});

describe('F16-001 · the mock surface is gated in production, independently of the page', () => {
  const cases = [
    ['approveAction', approveAction],
    ['declineAction', declineAction],
  ] as const;

  for (const [name, action] of cases) {
    it(`${name} refuses to run in production`, async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('PAYMENT_GATEWAY', 'mock');
      await expect(action(form(ABSENT_PAYMENT))).rejects.toThrow(/not available in production/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`${name} refuses when a real gateway is configured`, async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('PAYMENT_GATEWAY', 'bog');
      await expect(action(form(ABSENT_PAYMENT))).rejects.toThrow(/require PAYMENT_GATEWAY=mock/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
});

describe('F16-001 · no server action accepts a caller-supplied destination', () => {
  it('performs no outbound request at all, in any environment', async () => {
    enableMock();
    // Reaches the shared applier, which cannot find the payment. That failure
    // is the proof it got as far as the business logic without any HTTP.
    await expect(approveAction(form(ABSENT_PAYMENT))).rejects.toThrow(/payment not found/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores a webhook field entirely — a metadata target changes nothing', async () => {
    enableMock();
    await expect(
      approveAction(
        form({ ...ABSENT_PAYMENT, webhook: 'http://169.254.169.254/latest/meta-data/' }),
      ),
    ).rejects.toThrow(/payment not found/i);
    // Same failure as without the field: the parameter is not read, so it
    // cannot influence protocol, host, port or path.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['file:///etc/passwd'],
    ['gopher://127.0.0.1:11211/'],
    ['http://[fd00:ec2::254]/'],
    ['http://localhost:5432/'],
    ['//evil.example.com/api/webhooks/payment'],
  ])('ignores a %s webhook field', async (hostile) => {
    enableMock();
    await expect(
      approveAction(form({ ...ABSENT_PAYMENT, webhook: hostile })),
    ).rejects.toThrow(/payment not found/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the source module contains no fetch call', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/dev/mock-gateway/pay/actions.ts', 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    // And the redirect no longer hands the browser a destination to tamper with.
    const mockSrc = readFileSync('lib/payments/gateways/mock.ts', 'utf8');
    expect(mockSrc).not.toMatch(/webhook:\s*input\.webhookUrl/);
  });
});

describe('F16-001 · the return path cannot become an open redirect', () => {
  it.each([
    ['//evil.example.com'],
    ['https://evil.example.com/x'],
    ['http://evil.example.com'],
    ['/\\evil.example.com'],
    ['javascript:alert(1)'],
    ['evil.example.com'],
    ['/x:whatever'],
    ['/billing\r\nSet-Cookie: a=b'],
    [''],
    [null],
  ])('rejects %s and returns /billing', (hostile) => {
    expect(safeReturnPath(hostile as string | null)).toBe('/billing');
  });

  // Complement: legitimate in-app paths must survive, or the guard has just
  // broken the return journey instead of securing it.
  it.each([['/billing'], ['/billing/return?paymentId=abc'], ['/scheduler'], ['/']])(
    'preserves %s',
    (safe) => {
      expect(safeReturnPath(safe)).toBe(safe);
    },
  );

  it('is what the actions actually call', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/dev/mock-gateway/pay/actions.ts', 'utf8');
    // Two redirects, both routed through the helper — never fd.get() directly.
    expect(src.match(/redirect\(safeReturnPath\(/g)).toHaveLength(2);
    expect(src).not.toMatch(/redirect\(String\(fd\.get/);
  });
});

describe('F16-002/001 · the test network guard itself refuses metadata targets', () => {
  it.each([
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://metadata.google.internal/'],
    ['http://100.100.100.200/'],
    ['http://169.254.170.2/v2/credentials'],
  ])('refuses %s', (target) => {
    expect(() => __assertSafeFetchTarget(target)).toThrow(/net guard/i);
  });

  it.each([['file:///etc/passwd'], ['gopher://127.0.0.1/']])('refuses scheme %s', (target) => {
    expect(() => __assertSafeFetchTarget(target)).toThrow(/net guard/i);
  });

  it('allows loopback, which Playwright and the local server need', () => {
    expect(() => __assertSafeFetchTarget('http://localhost:3000/api/health')).not.toThrow();
    expect(() => __assertSafeFetchTarget('http://127.0.0.1:3000/')).not.toThrow();
  });
});
