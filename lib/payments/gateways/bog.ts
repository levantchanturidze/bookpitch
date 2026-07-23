import { createPublicKey, createVerify } from 'node:crypto';
import type {
  InitiateInput,
  InitiateResult,
  PaymentGateway,
  WebhookResult,
} from '../gateway';
import { GatewayVerificationError } from '../gateway';

// -----------------------------------------------------------------------------
// Bank of Georgia — iPay (Hosted Payment Page) v1.
// Docs: https://api.bog.ge/docs/payments/introduction
//
// Auth:   POST oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token
//         client_credentials — returns short-lived Bearer.
// Create: POST api.bog.ge/payments/v1/ecommerce/orders
// Result: response.links.redirect.href + response.id.
// Callback: BoG POSTs the order body to our webhook and signs the raw body
//           with RSA-SHA256; we verify with their published public key.
// -----------------------------------------------------------------------------

const OAUTH_URL = 'https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token';
const ORDERS_URL = 'https://api.bog.ge/payments/v1/ecommerce/orders';
const SIG_HEADER = 'callback-signature';
const REQUEST_TIMEOUT_MS = 10_000;

type TokenCacheEntry = { token: string; expiresAt: number };
let tokenCache: TokenCacheEntry | null = null;

export class BogGateway implements PaymentGateway {
  readonly name = 'bog';

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    const clientId = requireEnv('BOG_CLIENT_ID');
    const clientSecret = requireEnv('BOG_CLIENT_SECRET');
    const token = await this.getAccessToken(clientId, clientSecret);

    const body = {
      callback_url: input.webhookUrl,
      external_order_id: input.paymentId,
      purchase_units: {
        currency: input.currency,
        total_amount: input.amount,
        basket: [
          {
            product_id: input.paymentId,
            description: input.appointmentSummary,
            quantity: 1,
            unit_price: input.amount,
          },
        ],
      },
      redirect_urls: {
        success: input.callbackUrl,
        fail: input.callbackUrl,
      },
    };

    const res = await fetchWithTimeout(ORDERS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // BoG uses this to disambiguate replayed clicks; safe to reuse
        // our own paymentId — the gateway treats it as opaque.
        'Idempotency-Key': input.paymentId,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`BoG initiate failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      id?: string;
      _links?: { redirect?: { href?: string } };
      links?: { redirect?: { href?: string } };
    };
    const redirectUrl = json._links?.redirect?.href ?? json.links?.redirect?.href;
    const gatewayTxnId = json.id;
    if (!redirectUrl || !gatewayTxnId) {
      throw new Error('BoG initiate: response missing id/redirect link');
    }
    return { redirectUrl, gatewayTxnId };
  }

  async verifyWebhook(headers: Headers, rawBody: string): Promise<WebhookResult> {
    const sig = headers.get(SIG_HEADER);
    if (!sig) throw new GatewayVerificationError('missing Callback-Signature header');

    const pubKeyPem = requireEnv('BOG_WEBHOOK_PUBLIC_KEY');
    let key;
    try {
      key = createPublicKey(pubKeyPem);
    } catch (err) {
      throw new GatewayVerificationError(`invalid BOG_WEBHOOK_PUBLIC_KEY: ${(err as Error).message}`);
    }
    const verifier = createVerify('RSA-SHA256').update(rawBody);
    const ok = verifier.verify(key, Buffer.from(sig, 'base64'));
    if (!ok) throw new GatewayVerificationError('signature mismatch');

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new GatewayVerificationError('body is not JSON');
    }
    const b = parsed as {
      body?: {
        external_order_id?: unknown;
        order_id?: unknown;
        order_status?: { key?: unknown };
      };
    };
    const paymentId = b.body?.external_order_id;
    const gatewayTxnId = b.body?.order_id;
    const status = mapBogStatus(b.body?.order_status?.key);
    if (typeof paymentId !== 'string' || typeof gatewayTxnId !== 'string' || !status) {
      throw new GatewayVerificationError('missing or invalid fields');
    }
    return { paymentId, gatewayTxnId, status };
  }

  private async getAccessToken(clientId: string, clientSecret: string): Promise<string> {
    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt - 30_000 > now) return tokenCache.token;

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetchWithTimeout(OAUTH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`BoG OAuth failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('BoG OAuth: no access_token in response');
    tokenCache = {
      token: json.access_token,
      expiresAt: now + (json.expires_in ?? 300) * 1000,
    };
    return json.access_token;
  }
}

function mapBogStatus(key: unknown): 'paid' | 'failed' | null {
  if (typeof key !== 'string') return null;
  const k = key.toLowerCase();
  if (k === 'completed' || k === 'paid') return 'paid';
  if (k === 'rejected' || k === 'refunded' || k === 'blocked' || k === 'partial_refunded') {
    return 'failed';
  }
  return null;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — required for the BoG gateway`);
  return v;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
