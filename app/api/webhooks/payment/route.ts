import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { GatewayVerificationError, getGateway } from '@/lib/payments/gateway';
import { applyWebhook } from '@/lib/payments/service';

// POST /api/webhooks/payment
//
// Public — no session. Authenticated by the gateway's own signing scheme
// (see lib/payments/gateways/*). This is the ONLY source of truth for card
// payment success: never trust the client redirect.
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const gateway = getGateway();

  let result;
  try {
    result = await gateway.verifyWebhook(req.headers, rawBody);
  } catch (err) {
    if (err instanceof GatewayVerificationError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const outcome = await applyWebhook(result.paymentId, result.gatewayTxnId, result.status);
  if (outcome === 'not_found') {
    return NextResponse.json({ error: 'payment not found' }, { status: 404 });
  }
  // Return 200 for `applied`, `duplicate`, and `failed_recorded` — the
  // gateway needs an ack either way so it stops retrying.
  return NextResponse.json({ outcome });
}
