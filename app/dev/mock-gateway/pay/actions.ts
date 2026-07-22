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

async function postWebhook(payload: {
  paymentId: string;
  gatewayTxnId: string;
  status: 'paid' | 'failed';
  webhookUrl: string;
}) {
  const gw = new MockGateway();
  const body = JSON.stringify({
    paymentId: payload.paymentId,
    gatewayTxnId: payload.gatewayTxnId,
    status: payload.status,
  });
  const signature = gw.sign(body);
  const res = await fetch(payload.webhookUrl, {
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
