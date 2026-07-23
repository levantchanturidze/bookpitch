import { describe, it, expect, beforeAll } from 'vitest';
import { createHmac, generateKeyPairSync, createSign } from 'node:crypto';
import { BogGateway } from '@/lib/payments/gateways/bog';
import { TbcGateway } from '@/lib/payments/gateways/tbc';
import { GatewayVerificationError } from '@/lib/payments/gateway';

// -----------------------------------------------------------------------------
// Signature-verification tests for the two real Georgian gateways. We generate
// keys/secrets on the fly so nothing depends on live BoG/TBC credentials.
// -----------------------------------------------------------------------------

describe('BogGateway.verifyWebhook', () => {
  let privateKey: string;
  const bog = new BogGateway();

  beforeAll(() => {
    const kp = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = kp.privateKey;
    process.env.BOG_WEBHOOK_PUBLIC_KEY = kp.publicKey;
  });

  function sign(body: string): string {
    return createSign('RSA-SHA256').update(body).end().sign(privateKey, 'base64');
  }

  it('accepts a well-signed completed order and maps to "paid"', async () => {
    const body = JSON.stringify({
      body: {
        external_order_id: 'pay-uuid-1',
        order_id: 'bog-txn-1',
        order_status: { key: 'completed' },
      },
    });
    const headers = new Headers({ 'callback-signature': sign(body) });
    const res = await bog.verifyWebhook(headers, body);
    expect(res).toEqual({ paymentId: 'pay-uuid-1', gatewayTxnId: 'bog-txn-1', status: 'paid' });
  });

  it('maps "rejected" to "failed"', async () => {
    const body = JSON.stringify({
      body: {
        external_order_id: 'pay-uuid-2',
        order_id: 'bog-txn-2',
        order_status: { key: 'rejected' },
      },
    });
    const headers = new Headers({ 'callback-signature': sign(body) });
    const res = await bog.verifyWebhook(headers, body);
    expect(res.status).toBe('failed');
  });

  it('rejects when signature is missing', async () => {
    const body = JSON.stringify({ body: {} });
    await expect(bog.verifyWebhook(new Headers(), body)).rejects.toBeInstanceOf(
      GatewayVerificationError,
    );
  });

  it('rejects a tampered body', async () => {
    const body = JSON.stringify({
      body: {
        external_order_id: 'pay-uuid-3',
        order_id: 'bog-txn-3',
        order_status: { key: 'completed' },
      },
    });
    const goodSig = sign(body);
    const tampered = body.replace('pay-uuid-3', 'pay-uuid-3a');
    const headers = new Headers({ 'callback-signature': goodSig });
    await expect(bog.verifyWebhook(headers, tampered)).rejects.toBeInstanceOf(
      GatewayVerificationError,
    );
  });
});

describe('TbcGateway.verifyWebhook', () => {
  const secret = 'test-tbc-webhook-secret-xyz';
  const tbc = new TbcGateway();

  beforeAll(() => {
    process.env.TBC_WEBHOOK_SECRET = secret;
  });

  function sign(body: string): string {
    return createHmac('sha256', secret).update(body).digest('base64');
  }

  it('accepts a well-signed success and maps to "paid"', async () => {
    const body = JSON.stringify({
      merchantPaymentId: 'pay-uuid-a',
      payId: 'tbc-txn-a',
      status: 'Succeeded',
    });
    const headers = new Headers({ 'x-signature': sign(body) });
    const res = await tbc.verifyWebhook(headers, body);
    expect(res).toEqual({ paymentId: 'pay-uuid-a', gatewayTxnId: 'tbc-txn-a', status: 'paid' });
  });

  it('maps "Canceled" to "failed"', async () => {
    const body = JSON.stringify({
      merchantPaymentId: 'pay-uuid-b',
      payId: 'tbc-txn-b',
      status: 'Canceled',
    });
    const headers = new Headers({ 'x-signature': sign(body) });
    expect((await tbc.verifyWebhook(headers, body)).status).toBe('failed');
  });

  it('rejects when signature mismatches', async () => {
    const body = JSON.stringify({
      merchantPaymentId: 'pay-uuid-c',
      payId: 'tbc-txn-c',
      status: 'Succeeded',
    });
    const headers = new Headers({ 'x-signature': 'not-a-valid-signature' });
    await expect(tbc.verifyWebhook(headers, body)).rejects.toBeInstanceOf(
      GatewayVerificationError,
    );
  });

  it('rejects unknown status strings', async () => {
    const body = JSON.stringify({
      merchantPaymentId: 'pay-uuid-d',
      payId: 'tbc-txn-d',
      status: 'wat',
    });
    const headers = new Headers({ 'x-signature': sign(body) });
    await expect(tbc.verifyWebhook(headers, body)).rejects.toBeInstanceOf(
      GatewayVerificationError,
    );
  });
});
