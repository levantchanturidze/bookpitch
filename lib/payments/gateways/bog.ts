import type {
  InitiateInput,
  InitiateResult,
  PaymentGateway,
  WebhookResult,
} from '../gateway';

// Placeholder for BoG iPay Hosted Payment Page integration. Real API:
// https://developer.bog.ge/docs/net-payments/introduction
// Requires PAYMENT_MERCHANT_ID + PAYMENT_API_KEY + PAYMENT_WEBHOOK_SECRET.
// Adapter shape from gateway.ts is stable — implement these two methods and
// swap PAYMENT_GATEWAY=bog to go live.
export class BogGateway implements PaymentGateway {
  readonly name = 'bog';

  async initiate(_input: InitiateInput): Promise<InitiateResult> {
    throw new Error('BoG iPay adapter is not wired yet — provide merchant credentials');
  }

  async verifyWebhook(_headers: Headers, _rawBody: string): Promise<WebhookResult> {
    throw new Error('BoG iPay adapter is not wired yet — provide merchant credentials');
  }
}
