'use server';

import { redirect } from 'next/navigation';
import { MockGateway } from '@/lib/payments/gateways/mock';

// -----------------------------------------------------------------------------
// Server actions used by the mock-gateway "checkout" page. Each action builds
// the same signed webhook payload a real gateway would POST, hits our own
// webhook route via fetch, then redirects the browser to the caller-supplied
// return URL. Faithful to the real flow: the webhook is the source of truth,
// not the redirect.
// -----------------------------------------------------------------------------

/**
 * Server actions are addressable by id independently of the page that renders
 * them: `notFound()` in the page component does not unregister them. These two
 * actions sign a webhook with PAYMENT_MOCK_SECRET and POST it wherever they are
 * told, so without their own gate they stayed reachable in any environment the
 * bundle shipped to. Both guards below are deliberately inside the actions.
 */
function assertMockGatewayAvailable(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('mock gateway actions are not available in production');
  }
  if ((process.env.PAYMENT_GATEWAY ?? 'mock').trim().toLowerCase() !== 'mock') {
    throw new Error('mock gateway actions require PAYMENT_GATEWAY=mock');
  }
}

/**
 * The legitimate flow always passes `${APP_URL}/api/webhooks/payment`
 * (lib/payments/service.ts). Taking the value on trust let a caller aim a
 * validly signed POST at any host the server can reach, so pin it to our own
 * origin and route.
 */
function assertOwnWebhookUrl(raw: string): string {
  const appOrigin = process.env.APP_URL ?? 'http://localhost:3000';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('webhook url must be an absolute URL');
  }
  if (url.origin !== new URL(appOrigin).origin) {
    throw new Error('webhook url must target this application');
  }
  if (url.pathname !== '/api/webhooks/payment') {
    throw new Error('webhook url must target the payment webhook route');
  }
  return url.toString();
}

async function postWebhook(payload: {
  paymentId: string;
  gatewayTxnId: string;
  status: 'paid' | 'failed';
  webhookUrl: string;
}) {
  assertMockGatewayAvailable();
  const webhookUrl = assertOwnWebhookUrl(payload.webhookUrl);
  const gw = new MockGateway();
  const body = JSON.stringify({
    paymentId: payload.paymentId,
    gatewayTxnId: payload.gatewayTxnId,
    status: payload.status,
  });
  const signature = gw.sign(body);
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mock-signature': signature,
    },
    body,
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`webhook returned ${res.status}: ${text}`);
  }
}

export async function approveAction(fd: FormData) {
  await postWebhook({
    paymentId: String(fd.get('paymentId') ?? ''),
    gatewayTxnId: String(fd.get('gatewayTxnId') ?? ''),
    status: 'paid',
    webhookUrl: String(fd.get('webhook') ?? ''),
  });
  redirect(String(fd.get('callback') ?? '/billing'));
}

export async function declineAction(fd: FormData) {
  await postWebhook({
    paymentId: String(fd.get('paymentId') ?? ''),
    gatewayTxnId: String(fd.get('gatewayTxnId') ?? ''),
    status: 'failed',
    webhookUrl: String(fd.get('webhook') ?? ''),
  });
  redirect(String(fd.get('callback') ?? '/billing'));
}
