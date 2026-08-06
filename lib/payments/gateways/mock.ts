import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { InitiateInput, InitiateResult, PaymentGateway, WebhookResult } from '../gateway';
import { GatewayVerificationError } from '../gateway';

// -----------------------------------------------------------------------------
// Mock gateway — walks the whole redirect + webhook flow locally with no
// external calls. Payload structure mirrors what a real gateway sends: a
// JSON body signed with an HMAC-SHA256 header. Swap this out for
// gateways/bog.ts or gateways/tbc.ts once merchant credentials exist.
// -----------------------------------------------------------------------------

const SIG_HEADER = 'x-mock-signature';

export class MockGateway implements PaymentGateway {
  readonly name = 'mock';

  private secret(): string {
    const s = process.env.PAYMENT_MOCK_SECRET;
    if (!s) throw new Error('PAYMENT_MOCK_SECRET is not set — check .env.local');
    return s;
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    const gatewayTxnId = `mock_${randomBytes(6).toString('hex')}`;
    // Redirect the payer to our own /dev/mock-gateway page which will POST
    // the signed payload to `webhookUrl` when they click Approve.
    const params = new URLSearchParams({
      paymentId: input.paymentId,
      gatewayTxnId,
      amount: input.amount.toString(),
      currency: input.currency,
      summary: input.appointmentSummary,
      callback: input.callbackUrl,
      webhook: input.webhookUrl,
    });
    const appOrigin = process.env.APP_URL ?? 'http://localhost:3000';
    return {
      redirectUrl: `${appOrigin}/dev/mock-gateway/pay?${params.toString()}`,
      gatewayTxnId,
    };
  }

  /**
   * Sign an outgoing webhook body — exposed for the /dev/mock-gateway page
   * so it can produce a payload the webhook handler will accept.
   */
  sign(body: string): string {
    return createHmac('sha256', this.secret()).update(body).digest('hex');
  }

  async verifyWebhook(headers: Headers, rawBody: string): Promise<WebhookResult> {
    const provided = headers.get(SIG_HEADER);
    if (!provided) throw new GatewayVerificationError('missing signature header');

    const expected = this.sign(rawBody);
    // Constant-time compare avoids timing oracles.
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new GatewayVerificationError('signature mismatch');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new GatewayVerificationError('body is not JSON');
    }
    const p = parsed as {
      paymentId?: unknown;
      gatewayTxnId?: unknown;
      status?: unknown;
    };
    if (
      typeof p.paymentId !== 'string' ||
      typeof p.gatewayTxnId !== 'string' ||
      (p.status !== 'paid' && p.status !== 'failed')
    ) {
      throw new GatewayVerificationError('missing or invalid fields');
    }
    return { paymentId: p.paymentId, gatewayTxnId: p.gatewayTxnId, status: p.status };
  }
}
