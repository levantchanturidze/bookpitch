import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InitiateInput, InitiateResult, PaymentGateway, WebhookResult } from '../gateway';
import { GatewayVerificationError } from '../gateway';

// -----------------------------------------------------------------------------
// TBC Bank — E-Commerce Card Payments API (Hosted Payment Page).
// Docs: https://api.tbcbank.ge/docs/ecommerce/
//
// Auth: POST /v1/tpay/access-token with apikey header + client_Id/client_secret
//       returns short-lived Bearer.
// Init: POST /v1/tpay/payments with Bearer — response has payId + links.approval.
// Callback: TBC POSTs the transaction body; the header X-Signature is a
//           base64 HMAC-SHA256 over the raw body using TBC_WEBHOOK_SECRET.
// -----------------------------------------------------------------------------

const BASE_URL = 'https://api.tbcbank.ge/v1/tpay';
const SIG_HEADER = 'x-signature';
const REQUEST_TIMEOUT_MS = 10_000;

type TokenCacheEntry = { token: string; expiresAt: number };
let tokenCache: TokenCacheEntry | null = null;

export class TbcGateway implements PaymentGateway {
  readonly name = 'tbc';

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    const apiKey = requireEnv('TBC_API_KEY');
    const clientId = requireEnv('TBC_CLIENT_ID');
    const clientSecret = requireEnv('TBC_CLIENT_SECRET');
    const token = await this.getAccessToken(apiKey, clientId, clientSecret);

    const body = {
      amount: { currency: input.currency, total: input.amount },
      returnurl: input.callbackUrl,
      callbackUrl: input.webhookUrl,
      merchantPaymentId: input.paymentId,
      description: input.appointmentSummary.slice(0, 100),
    };

    const res = await fetchWithTimeout(`${BASE_URL}/payments`, {
      method: 'POST',
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`TBC initiate failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      payId?: string;
      links?: Array<{ rel?: string; uri?: string }>;
    };
    const gatewayTxnId = json.payId;
    const redirectUrl = json.links?.find((l) => l.rel === 'approval')?.uri;
    if (!gatewayTxnId || !redirectUrl) {
      throw new Error('TBC initiate: response missing payId/approval link');
    }
    return { redirectUrl, gatewayTxnId };
  }

  async verifyWebhook(headers: Headers, rawBody: string): Promise<WebhookResult> {
    const provided = headers.get(SIG_HEADER);
    if (!provided) throw new GatewayVerificationError('missing X-Signature header');
    const secret = requireEnv('TBC_WEBHOOK_SECRET');
    const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
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
      merchantPaymentId?: unknown;
      payId?: unknown;
      status?: unknown;
    };
    const status = mapTbcStatus(p.status);
    if (typeof p.merchantPaymentId !== 'string' || typeof p.payId !== 'string' || !status) {
      throw new GatewayVerificationError('missing or invalid fields');
    }
    return { paymentId: p.merchantPaymentId, gatewayTxnId: p.payId, status };
  }

  private async getAccessToken(apiKey: string, clientId: string, clientSecret: string) {
    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt - 30_000 > now) return tokenCache.token;
    const res = await fetchWithTimeout(`${BASE_URL}/access-token`, {
      method: 'POST',
      headers: {
        apikey: apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ client_Id: clientId, client_secret: clientSecret }).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`TBC access-token failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('TBC access-token: missing access_token');
    tokenCache = {
      token: json.access_token,
      expiresAt: now + (json.expires_in ?? 300) * 1000,
    };
    return json.access_token;
  }
}

function mapTbcStatus(status: unknown): 'paid' | 'failed' | null {
  if (typeof status !== 'string') return null;
  const s = status.toLowerCase();
  if (s === 'succeeded' || s === 'success' || s === 'paid') return 'paid';
  if (s === 'failed' || s === 'canceled' || s === 'rejected' || s === 'expired') return 'failed';
  return null;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — required for the TBC gateway`);
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
