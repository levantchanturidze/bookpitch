// -----------------------------------------------------------------------------
// Gateway adapter interface. Every real Georgian gateway (BoG iPay, TBC
// E-Commerce, UniPay aggregator) exposes the same two operations: kick off
// a Hosted Payment Page redirect, and verify an incoming webhook payload.
//
// Adapters keep card data OUT of our servers: we only ever see the gateway's
// txn id + status.
// -----------------------------------------------------------------------------

export type GatewayStatus = 'paid' | 'failed';

export type InitiateInput = {
  paymentId: string; // our uuid — round-tripped through the gateway
  amount: number; // major units (e.g. GEL); adapters convert to minor if needed
  currency: string;
  appointmentSummary: string; // shown to the payer on the hosted page
  callbackUrl: string; // where the gateway sends the payer after checkout
  webhookUrl: string; // where the gateway POSTs the signed result
};

export type InitiateResult = {
  redirectUrl: string; // send the browser here
  gatewayTxnId: string; // opaque provider id, persist on the payments row
};

export type WebhookResult = {
  paymentId: string; // our uuid
  gatewayTxnId: string;
  status: GatewayStatus;
};

export interface PaymentGateway {
  readonly name: string;
  initiate(input: InitiateInput): Promise<InitiateResult>;
  /**
   * Validate the incoming request (typically via HMAC on the raw body) and
   * extract the outcome. Throws if the signature is invalid or the payload
   * malformed — the route handler translates that to a 401.
   */
  verifyWebhook(headers: Headers, rawBody: string): Promise<WebhookResult>;
}

import { MockGateway } from './gateways/mock';
import { BogGateway } from './gateways/bog';
import { TbcGateway } from './gateways/tbc';

/**
 * Resolves the adapter by env. Called once per request (cheap — adapters
 * are stateless).
 */
export function getGateway(): PaymentGateway {
  const name = (process.env.PAYMENT_GATEWAY ?? 'mock').toLowerCase();
  switch (name) {
    case 'mock':
      return new MockGateway();
    case 'bog':
    case 'bog_ipay':
      return new BogGateway();
    case 'tbc':
    case 'tbc_ecommerce':
      return new TbcGateway();
    default:
      throw new Error(`Unknown PAYMENT_GATEWAY: ${name}`);
  }
}

export class GatewayVerificationError extends Error {
  constructor(message = 'Invalid webhook signature or payload') {
    super(message);
    this.name = 'GatewayVerificationError';
  }
}
