import type { NextRequest } from 'next/server';
import { InvalidInputError, ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { startCardCheckout } from '@/lib/payments/service';

// POST /api/payments/checkout
// Body: { appointmentId: string }
// Response: { paymentId, redirectUrl }
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'payment.charge',
      { organizationId: ctx.activeOrganizationId! },
      'payments',
    );
    const body = (await req.json().catch(() => null)) as { appointmentId?: unknown } | null;
    const appointmentId = typeof body?.appointmentId === 'string' ? body.appointmentId : '';
    if (!appointmentId) throw new InvalidInputError('appointmentId is required');
    return startCardCheckout(ctxToSession(ctx), appointmentId);
  });
}
