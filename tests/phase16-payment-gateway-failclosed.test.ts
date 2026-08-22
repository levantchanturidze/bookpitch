import { describe, it, expect, vi, afterEach } from 'vitest';
import { getGateway } from '@/lib/payments/gateway';
import { MockGateway } from '@/lib/payments/gateways/mock';
import { BogGateway } from '@/lib/payments/gateways/bog';
import { approveAction, declineAction } from '@/app/dev/mock-gateway/pay/actions';

// -----------------------------------------------------------------------------
// F16-001. Two defects, one root: the mock payment gateway was reachable in
// production.
//
//   1. getGateway() resolved `PAYMENT_GATEWAY ?? 'mock'`, so an unset variable
//      selected MockGateway — the adapter that signs its own webhooks and
//      reports every payment as paid.
//   2. The mock "hosted payment page" server actions had no environment gate at
//      all. Server actions are addressable by id, so the page's notFound() did
//      not protect them, and postWebhook() fetched a caller-supplied URL with a
//      valid PAYMENT_MOCK_SECRET signature attached.
//
// getGateway() had no test of its own before this file: every existing payment
// test constructed an adapter directly, so the resolution path that actually
// runs in production was never exercised.
// -----------------------------------------------------------------------------

const OWN_WEBHOOK = 'http://localhost:3000/api/webhooks/payment';

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  // Complement: the same inputs outside production must still work, or the fix
  // would simply have broken local development instead of securing production.
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

  // A real gateway must be unaffected in production — that is the whole point.
  it('resolves a real gateway in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_GATEWAY', 'bog');
    expect(getGateway()).toBeInstanceOf(BogGateway);
  });

  it('rejects an unknown gateway name', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_GATEWAY', 'definitely-not-a-gateway');
    expect(() => getGateway()).toThrow(/Unknown PAYMENT_GATEWAY/i);
  });
});

describe('F16-001 · mock gateway server actions are gated independently of the page', () => {
  function form(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  }

  const validFields = {
    paymentId: 'p-1',
    gatewayTxnId: 'tx-1',
    callback: '/billing',
    webhook: OWN_WEBHOOK,
  };

  it('approveAction refuses to run in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_GATEWAY', 'mock');
    await expect(approveAction(form(validFields))).rejects.toThrow(/not available in production/i);
  });

  it('declineAction refuses to run in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_GATEWAY', 'mock');
    await expect(declineAction(form(validFields))).rejects.toThrow(/not available in production/i);
  });

  it('refuses to run when a real gateway is configured', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PAYMENT_GATEWAY', 'bog');
    await expect(approveAction(form(validFields))).rejects.toThrow(/require PAYMENT_GATEWAY=mock/i);
  });

  it('refuses a webhook url pointing at another origin (SSRF)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PAYMENT_GATEWAY', 'mock');
    vi.stubEnv('APP_URL', 'http://localhost:3000');
    await expect(
      approveAction(form({ ...validFields, webhook: 'http://169.254.169.254/latest/meta-data/' })),
    ).rejects.toThrow(/must target this application/i);
  });

  it('refuses a same-origin url pointing at a different route', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PAYMENT_GATEWAY', 'mock');
    vi.stubEnv('APP_URL', 'http://localhost:3000');
    await expect(
      approveAction(form({ ...validFields, webhook: 'http://localhost:3000/api/customers' })),
    ).rejects.toThrow(/must target the payment webhook route/i);
  });

  it('refuses a non-absolute webhook url', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PAYMENT_GATEWAY', 'mock');
    await expect(
      approveAction(form({ ...validFields, webhook: '/api/webhooks/payment' })),
    ).rejects.toThrow(/absolute URL/i);
  });

  // Complement: a legitimate call must get past every guard and reach the
  // fetch. It fails at the network, not at a guard — proving the guards are
  // scoped to the abuse cases and have not simply disabled the feature.
  it('lets a legitimate same-origin call through to the webhook fetch', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PAYMENT_GATEWAY', 'mock');
    vi.stubEnv('APP_URL', 'http://localhost:3000');
    vi.stubEnv('PAYMENT_MOCK_SECRET', 'test-secret');

    const seen: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ outcome: 'applied' }), { status: 200 });
    });

    // redirect() throws its own control-flow signal after a successful post.
    await approveAction(form(validFields)).catch(() => undefined);

    expect(seen).toEqual([OWN_WEBHOOK]);
    fetchSpy.mockRestore();
  });
});
