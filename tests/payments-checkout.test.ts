import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const routeCheckout = await import('@/app/api/payments/checkout/route');
const routeCash = await import('@/app/api/payments/cash/route');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');

import type { NextRequest } from 'next/server';
function req(url: string, init: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function mkSession(orgId: string, userId: string) {
  return mockJwt(userId, orgId);
}

describe('/api/payments/{checkout,cash}', () => {
  let orgId: string;
  let userId: string;
  let unpaidApptId: string;
  const createdPaymentIds: string[] = [];

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const primary = await tx.organization.findFirst({
        where: { name: { not: 'Isolation Corp' } },
        orderBy: { createdAt: 'asc' },
      });
      const owner = await tx.appUser.findUnique({
        where: { email: 'owner@bookpitch.dev' },
        select: { id: true },
      });
      const appt = await tx.appointment.findFirst({
        where: { organizationId: primary!.id, paymentStatus: 'unpaid' },
      });
      return { orgId: primary!.id, userId: owner!.id, apptId: appt!.id };
    });
    orgId = seed.orgId;
    userId = seed.userId;
    unpaidApptId = seed.apptId;
  });

  afterAll(async () => {
    if (createdPaymentIds.length) {
      await withoutRls((tx) =>
        tx.payment.deleteMany({ where: { id: { in: createdPaymentIds } } }),
      );
    }
    // Restore the seeded appointment to unpaid for other suites.
    await withoutRls((tx) =>
      tx.appointment.update({
        where: { id: unpaidApptId },
        data: { paymentStatus: 'unpaid' },
      }),
    );
  });

  beforeEach(() => { authMock.mockReset(); __clearAuthContextCache(); });

  it('checkout creates an unpaid payment + returns a mock-gateway redirect URL', async () => {
    authMock.mockResolvedValue(await mkSession(orgId, userId));
    const res = await routeCheckout.POST(
      req('http://x/api/payments/checkout', {
        method: 'POST',
        body: JSON.stringify({ appointmentId: unpaidApptId }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ paymentId: string; redirectUrl: string }>(res);
    expect(body.paymentId).toBeTruthy();
    expect(body.redirectUrl).toContain('/dev/mock-gateway/pay');
    expect(body.redirectUrl).toContain(`paymentId=${body.paymentId}`);
    createdPaymentIds.push(body.paymentId);

    const row = await withoutRls((tx) => tx.payment.findUnique({ where: { id: body.paymentId } }));
    expect(row?.status).toBe('unpaid');
    expect(row?.method).toBe('card');
    expect(row?.gateway).toBe('mock');
    expect(row?.gatewayTxnId).toBeTruthy();
    expect(Number(row?.amount)).toBeGreaterThan(0);
  });

  it('checkout rejects already-paid appointments (400)', async () => {
    // Flip the appointment to paid via a cash settlement first.
    authMock.mockResolvedValue(await mkSession(orgId, userId));
    const cashRes = await routeCash.POST(
      req('http://x/api/payments/cash', {
        method: 'POST',
        body: JSON.stringify({ appointmentId: unpaidApptId }),
      }),
    );
    expect(cashRes.status).toBe(200);
    const cashBody = await jsonBody<{ payment: { id: string } }>(cashRes);
    createdPaymentIds.push(cashBody.payment.id);

    authMock.mockResolvedValue(await mkSession(orgId, userId));
    const res = await routeCheckout.POST(
      req('http://x/api/payments/checkout', {
        method: 'POST',
        body: JSON.stringify({ appointmentId: unpaidApptId }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('cash settlement flips appointment.payment_status and writes a paid payment row', async () => {
    // Reset the appointment first (previous test paid it).
    await withoutRls((tx) =>
      tx.appointment.update({
        where: { id: unpaidApptId },
        data: { paymentStatus: 'unpaid' },
      }),
    );

    authMock.mockResolvedValue(await mkSession(orgId, userId));
    const res = await routeCash.POST(
      req('http://x/api/payments/cash', {
        method: 'POST',
        body: JSON.stringify({ appointmentId: unpaidApptId }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ payment: { id: string; status: string; method: string } }>(res);
    expect(body.payment.status).toBe('paid');
    expect(body.payment.method).toBe('cash');
    createdPaymentIds.push(body.payment.id);

    const appt = await withoutRls((tx) =>
      tx.appointment.findUnique({ where: { id: unpaidApptId } }),
    );
    expect(appt?.paymentStatus).toBe('paid');
  });
});
