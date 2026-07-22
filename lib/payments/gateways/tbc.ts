import type {
  InitiateInput,
  InitiateResult,
  PaymentGateway,
  WebhookResult,
} from '../gateway';

// Placeholder for TBC E-Commerce Hosted Payment Page integration. Real API:
// https://api.tbcbank.ge/docs/ecommerce/
// Requires PAYMENT_MERCHANT_ID + PAYMENT_API_KEY + PAYMENT_WEBHOOK_SECRET.
export class TbcGateway implements PaymentGateway {
  readonly name = 'tbc';

  async initiate(_input: InitiateInput): Promise<InitiateResult> {
    throw new Error('TBC E-Commerce adapter is not wired yet — provide merchant credentials');
  }

  async verifyWebhook(_headers: Headers, _rawBody: string): Promise<WebhookResult> {
    throw new Error('TBC E-Commerce adapter is not wired yet — provide merchant credentials');
  }
}
