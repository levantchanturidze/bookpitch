import type { NextRequest } from 'next/server';
import { InvalidInputError, requireRole, withApi } from '@/lib/auth';
import { startCardCheckout } from '@/lib/payments/service';

// POST /api/payments/checkout
// Body: { appointmentId: string }
// Response: { paymentId, redirectUrl }
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireRole('owner', 'receptionist');
    const body = (await req.json().catch(() => null)) as { appointmentId?: unknown } | null;
    const appointmentId = typeof body?.appointmentId === 'string' ? body.appointmentId : '';
    if (!appointmentId) throw new InvalidInputError('appointmentId is required');
    return startCardCheckout(session, appointmentId);
  });
}
