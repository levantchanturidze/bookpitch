import type { NextRequest } from 'next/server';
import { InvalidInputError, requireRole, withApi } from '@/lib/auth';
import { settleCash } from '@/lib/payments/service';

// POST /api/payments/cash
// Body: { appointmentId: string }
// Response: { payment }
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireRole('owner', 'receptionist');
    const body = (await req.json().catch(() => null)) as { appointmentId?: unknown } | null;
    const appointmentId = typeof body?.appointmentId === 'string' ? body.appointmentId : '';
    if (!appointmentId) throw new InvalidInputError('appointmentId is required');
    const payment = await settleCash(session, appointmentId);
    return { payment };
  });
}
