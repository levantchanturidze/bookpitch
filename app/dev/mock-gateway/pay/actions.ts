'use server';

import { redirect } from 'next/navigation';
import { MockGateway } from '@/lib/payments/gateways/mock';
import { applyWebhook } from '@/lib/payments/service';
import { safeReturnPath } from './return-path';

// -----------------------------------------------------------------------------
// Server actions behind the mock-gateway "checkout" page.
//
// These used to build a signed webhook payload and POST it over HTTP to a URL
// taken from a hidden form field. Two things were wrong with that:
//
//   1. Server actions are addressable by id. `notFound()` in the page component
//      does not unregister them, so the actions were reachable wherever the
//      bundle shipped, regardless of what the page decided to render.
//   2. The destination came from client-controlled input, so a caller could aim
//      a validly signed POST at any host the server could reach.
//
// The request is now gone entirely. The webhook route does exactly two things —
// verify the signature via the gateway adapter, then hand the result to
// applyWebhook() — and both run here in-process against the same functions. No
// URL is accepted, constructed, or contacted, so there is no destination left to
// influence. Idempotency, organization scoping and the audit entry all still
// come from applyWebhook(), which remains the single source of truth for
// payment state.
// -----------------------------------------------------------------------------

/** Where the mock surface is permitted to run at all. */
function assertMockGatewayAvailable(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('mock gateway actions are not available in production');
  }
  if ((process.env.PAYMENT_GATEWAY ?? 'mock').trim().toLowerCase() !== 'mock') {
    throw new Error('mock gateway actions require PAYMENT_GATEWAY=mock');
  }
}

/**
 * Replays the gateway's own verification and the shared applier, in-process.
 * Signature validation is not skipped — it is the same MockGateway.verifyWebhook
 * the route calls, so a broken signing path still fails here.
 */
async function applyMockOutcome(
  paymentId: string,
  gatewayTxnId: string,
  status: 'paid' | 'failed',
): Promise<void> {
  assertMockGatewayAvailable();

  const gateway = new MockGateway();
  const body = JSON.stringify({ paymentId, gatewayTxnId, status });
  const headers = new Headers({
    'content-type': 'application/json',
    'x-mock-signature': gateway.sign(body),
  });

  const result = await gateway.verifyWebhook(headers, body);
  const outcome = await applyWebhook(result.paymentId, result.gatewayTxnId, result.status);
  if (outcome === 'not_found') {
    throw new Error('payment not found');
  }
}

export async function approveAction(fd: FormData) {
  await applyMockOutcome(
    String(fd.get('paymentId') ?? ''),
    String(fd.get('gatewayTxnId') ?? ''),
    'paid',
  );
  redirect(safeReturnPath(fd.get('callback') as string | null));
}

export async function declineAction(fd: FormData) {
  await applyMockOutcome(
    String(fd.get('paymentId') ?? ''),
    String(fd.get('gatewayTxnId') ?? ''),
    'failed',
  );
  redirect(safeReturnPath(fd.get('callback') as string | null));
}
