import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

// Webhook is unauthenticated but its import chain drags in @/auth via
// lib/payments/service.ts. Stub so Node doesn't load next-auth internals.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const webhookRoute = await import('@/app/api/webhooks/payment/route');

import type { NextRequest } from 'next/server';
function req(url: string, init: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

function sign(body: string): string {
  return createHmac('sha256', process.env.PAYMENT_MOCK_SECRET!).update(body).digest('hex');
}

async function post(payload: Record<string, unknown>, signature?: string) {
  const body = JSON.stringify(payload);
  const sig = signature ?? sign(body);
  return webhookRoute.POST(
    req('http://x/api/webhooks/payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mock-signature': sig },
      body,
    }),
  );
}

describe('/api/webhooks/payment (mock gateway)', () => {
  let orgId: string;
  let appointmentId: string;

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const primary = await tx.organization.findFirst({
        where: { name: { not: 'Isolation Corp' } },
        orderBy: { createdAt: 'asc' },
      });
      const appt = await tx.appointment.findFirst({
        where: { organizationId: primary!.id, paymentStatus: 'unpaid' },
      });
      return { orgId: primary!.id, appointmentId: appt!.id };
    });
    orgId = seed.orgId;
    appointmentId = seed.appointmentId;
  });

  async function seedPendingPayment(): Promise<{ paymentId: string; gatewayTxnId: string }> {
    const gatewayTxnId = `mock_test_${Math.random().toString(16).slice(2, 10)}`;
    const p = await withoutRls((tx) =>
      tx.payment.create({
        data: {
          organizationId: orgId,
          appointmentId,
          method: 'card',
          amount: 100,
          currency: 'GEL',
          status: 'unpaid',
          gateway: 'mock',
          gatewayTxnId,
        },
      }),
    );
    return { paymentId: p.id, gatewayTxnId };
  }

  beforeEach(async () => {
    // Reset the seeded appointment's payment status between tests.
    await withoutRls((tx) =>
      tx.appointment.update({
        where: { id: appointmentId },
        data: { paymentStatus: 'unpaid' },
      }),
    );
  });

  it('rejects requests with a missing signature header (401)', async () => {
    const res = await webhookRoute.POST(
      req('http://x/api/webhooks/payment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentId: 'x', gatewayTxnId: 'y', status: 'paid' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects requests with a tampered signature (401)', async () => {
    const { paymentId, gatewayTxnId } = await seedPendingPayment();
    const res = await post({ paymentId, gatewayTxnId, status: 'paid' }, 'a'.repeat(64));
    expect(res.status).toBe(401);
  });

  it('paid webhook updates payment.status + appointment.payment_status', async () => {
    const { paymentId, gatewayTxnId } = await seedPendingPayment();
    const res = await post({ paymentId, gatewayTxnId, status: 'paid' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('applied');

    const payment = await withoutRls((tx) => tx.payment.findUnique({ where: { id: paymentId } }));
    expect(payment?.status).toBe('paid');
    expect(payment?.paidAt).toBeTruthy();

    const appt = await withoutRls((tx) =>
      tx.appointment.findUnique({ where: { id: appointmentId } }),
    );
    expect(appt?.paymentStatus).toBe('paid');
  });

  it('replaying the same signed webhook is idempotent (duplicate outcome, no extra audit)', async () => {
    const { paymentId, gatewayTxnId } = await seedPendingPayment();

    const first = await post({ paymentId, gatewayTxnId, status: 'paid' });
    expect(first.status).toBe(200);
    expect((await first.json()).outcome).toBe('applied');

    const auditBefore = await withoutRls((tx) =>
      tx.auditLog.count({ where: { entity: 'payment', entityId: paymentId } }),
    );

    const second = await post({ paymentId, gatewayTxnId, status: 'paid' });
    expect(second.status).toBe(200);
    expect((await second.json()).outcome).toBe('duplicate');

    const auditAfter = await withoutRls((tx) =>
      tx.auditLog.count({ where: { entity: 'payment', entityId: paymentId } }),
    );
    expect(auditAfter).toBe(auditBefore);
  });

  it('failed webhook leaves payment unpaid but records the outcome', async () => {
    const { paymentId, gatewayTxnId } = await seedPendingPayment();
    const res = await post({ paymentId, gatewayTxnId, status: 'failed' });
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('failed_recorded');

    const payment = await withoutRls((tx) => tx.payment.findUnique({ where: { id: paymentId } }));
    expect(payment?.status).toBe('unpaid');
  });

  it('returns 404 for an unknown payment id', async () => {
    const res = await post({
      paymentId: '00000000-0000-0000-0000-000000000000',
      gatewayTxnId: 'mock_zzz',
      status: 'paid',
    });
    expect(res.status).toBe(404);
  });
});
