import type { Payment, PrismaClient } from '@prisma/client';
import { InvalidInputError, type ActiveSession } from '@/lib/auth';
import { withOrg, withoutRls } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { notifyEvent } from '@/lib/notifications';
import { getGateway } from './gateway';
import { loadOrgToggles } from '@/lib/rbac';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

// -----------------------------------------------------------------------------
// Payments service: single place where /api and Server Actions converge.
// Keeps every writer wrapped in a tx that sets app.current_org_id (RLS) and
// writes an audit entry.
// -----------------------------------------------------------------------------

export type PaymentDto = {
  id: string;
  appointmentId: string | null;
  method: Payment['method'];
  gateway: string | null;
  gatewayTxnId: string | null;
  amount: number;
  currency: string;
  status: Payment['status'];
  paidAt: string | null;
  createdAt: string;
};

export function toPaymentDto(row: Payment): PaymentDto {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    method: row.method,
    gateway: row.gateway,
    gatewayTxnId: row.gatewayTxnId,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Card checkout — creates an unpaid `payments` row, kicks off the gateway.
// -----------------------------------------------------------------------------
export async function startCardCheckout(
  session: ActiveSession,
  appointmentId: string,
): Promise<{ paymentId: string; redirectUrl: string }> {
  const appointment = await withOrg(session.organizationId, (tx) =>
    tx.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        customer: { select: { name: true } },
        location: { select: { name: true } },
      },
    }),
  );
  if (!appointment) throw new InvalidInputError('appointment not found');
  if (appointment.paymentStatus === 'paid') {
    throw new InvalidInputError('appointment is already paid');
  }

  // Create the payment first so the gateway sees a real id round-tripped
  // through it. gateway_txn_id is filled in immediately after initiate().
  const payment = await withOrg(session.organizationId, async (tx) => {
    const row = await tx.payment.create({
      data: {
        organizationId: session.organizationId,
        appointmentId,
        method: 'card',
        amount: appointment.price,
        currency: 'GEL',
        status: 'unpaid',
        gateway: null,
        gatewayTxnId: null,
      },
    });
    await writeAudit(tx, session, 'create', 'payment', row.id, {
      appointmentId,
      amount: Number(row.amount),
    });
    return row;
  });

  const appOrigin = process.env.APP_URL ?? 'http://localhost:3000';
  const gateway = getGateway();
  const result = await gateway.initiate({
    paymentId: payment.id,
    amount: Number(payment.amount),
    currency: payment.currency,
    appointmentSummary: `${appointment.serviceName} · ${appointment.customer.name}`,
    callbackUrl: `${appOrigin}/billing/return?paymentId=${payment.id}`,
    webhookUrl: `${appOrigin}/api/webhooks/payment`,
  });

  await withOrg(session.organizationId, (tx) =>
    tx.payment.update({
      where: { id: payment.id },
      data: { gateway: gateway.name, gatewayTxnId: result.gatewayTxnId },
    }),
  );

  return { paymentId: payment.id, redirectUrl: result.redirectUrl };
}

// -----------------------------------------------------------------------------
// Cash POS shortcut — creates a paid payment + flips the appointment.
// -----------------------------------------------------------------------------
export async function settleCash(
  session: ActiveSession,
  appointmentId: string,
): Promise<PaymentDto> {
  return withOrg(session.organizationId, async (tx) => {
    const appt = await tx.appointment.findUnique({ where: { id: appointmentId } });
    if (!appt) throw new InvalidInputError('appointment not found');
    if (appt.paymentStatus === 'paid') {
      throw new InvalidInputError('appointment is already paid');
    }

    const now = new Date();
    const payment = await tx.payment.create({
      data: {
        organizationId: session.organizationId,
        appointmentId,
        method: 'cash',
        amount: appt.price,
        currency: 'GEL',
        status: 'paid',
        paidAt: now,
      },
    });
    await tx.appointment.update({
      where: { id: appointmentId },
      data: { paymentStatus: 'paid' },
    });
    await writeAudit(tx, session, 'create', 'payment', payment.id, {
      method: 'cash',
      appointmentId,
    });
    await notifyEvent(tx, session.organizationId, {
      type: 'payment',
      title: 'Cash payment recorded',
      body: `${Number(appt.price).toFixed(2)} GEL — ${appt.serviceName}`,
    });
    return toPaymentDto(payment);
  });
}

// -----------------------------------------------------------------------------
// Webhook handling — the ONLY source of truth for card payment success.
// Idempotent: same (paymentId, gatewayTxnId) landing twice is a no-op.
// Bypasses RLS via withoutRls because the caller has no session.
// -----------------------------------------------------------------------------
export type WebhookOutcome = 'applied' | 'duplicate' | 'failed_recorded' | 'not_found';

export async function applyWebhook(
  paymentId: string,
  gatewayTxnId: string,
  status: 'paid' | 'failed',
): Promise<WebhookOutcome> {
  return withoutRls(async (tx: TxClient): Promise<WebhookOutcome> => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return 'not_found';

    // Idempotency: once we've applied a paid result, ignore any repeat.
    if (payment.status === 'paid') return 'duplicate';

    if (status === 'failed') {
      // Keep the row so audit history is preserved; leave status=unpaid,
      // just record that we heard back.
      await tx.auditLog.create({
        data: {
          organizationId: payment.organizationId,
          action: 'update',
          entity: 'payment',
          entityId: payment.id,
          meta: { webhook: 'failed', gatewayTxnId },
        },
      });
      return 'failed_recorded';
    }

    const now = new Date();
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'paid',
        paidAt: now,
        gatewayTxnId, // matches whatever we stored, but re-persist for safety
      },
    });
    if (payment.appointmentId) {
      await tx.appointment.update({
        where: { id: payment.appointmentId },
        data: { paymentStatus: 'paid' },
      });
    }
    await tx.auditLog.create({
      data: {
        organizationId: payment.organizationId,
        // No actor — this is a system event, not a user action.
        action: 'update',
        entity: 'payment',
        entityId: payment.id,
        meta: { webhook: 'paid', gatewayTxnId, appointmentId: payment.appointmentId },
      },
    });
    await notifyEvent(tx, payment.organizationId, {
      type: 'payment',
      title: 'Payment received',
      body: `${Number(payment.amount).toFixed(2)} ${payment.currency} settled via ${payment.gateway ?? 'gateway'}`,
    });
    return 'applied';
  });
}

// -----------------------------------------------------------------------------
// Phase 6 spec §6.2 — front-desk discount ceiling.
//
// The org's `toggle.frontdesk.discount_ceiling` (numeric, currency units)
// caps the discretionary discount a FRONT_DESK caller can apply at
// checkout. Ceiling of 0 = no discretion (the default).
//
// Callers (the future discount pathway — not yet wired into checkout,
// which today always settles at `appointment.price`) must call this
// helper BEFORE persisting the discount so the check happens in the
// same tenant-scoped tx.
//
// Passing a caller with roleKey !== 'FRONT_DESK' is a no-op (owners /
// admins use `payment.discount:unlimited` per spec §5 and aren't bound
// by the ceiling).
// -----------------------------------------------------------------------------
export async function assertDiscountWithinCeiling(
  orgId: string,
  actorRoleKey: string | null,
  discountAmount: number,
): Promise<void> {
  if (actorRoleKey !== 'FRONT_DESK') return;
  if (discountAmount <= 0) return;
  const toggles = await loadOrgToggles(orgId);
  if (discountAmount > toggles.frontdeskDiscountCeiling) {
    throw new InvalidInputError(
      `discount ${discountAmount} exceeds the front-desk ceiling ${toggles.frontdeskDiscountCeiling}`,
    );
  }
}
