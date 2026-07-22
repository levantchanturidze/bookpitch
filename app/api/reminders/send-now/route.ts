import type { NextRequest } from 'next/server';
import { InvalidInputError, requireRole, withApi } from '@/lib/auth';
import { sendNowForSession } from '@/lib/messaging/reminders';

// POST /api/reminders/send-now  Body: { appointmentId: string }
// Bypasses the lead-time window but still honours per-channel idempotency.
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireRole('owner', 'receptionist');
    const body = (await req.json().catch(() => null)) as { appointmentId?: unknown } | null;
    const appointmentId = typeof body?.appointmentId === 'string' ? body.appointmentId : '';
    if (!appointmentId) throw new InvalidInputError('appointmentId is required');
    const reports = await sendNowForSession(session, appointmentId);
    return { reports };
  });
}
