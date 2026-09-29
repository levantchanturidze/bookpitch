import type { NextRequest } from 'next/server';
import { InvalidInputError, ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission, resolveAppointmentResource } from '@/lib/rbac';
import { sendNowForSession } from '@/lib/messaging/reminders';

// POST /api/reminders/send-now  Body: { appointmentId: string }
// Bypasses the lead-time window but still honours per-channel idempotency.
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const body = (await req.json().catch(() => null)) as { appointmentId?: unknown } | null;
    const appointmentId = typeof body?.appointmentId === 'string' ? body.appointmentId : '';
    if (!appointmentId) throw new InvalidInputError('appointmentId is required');
    // Resolve the appointment BEFORE authorising it — owner and branch
    // together (F-09 fixed the owner half; the branch half took list mode
    // until the scoped-RBAC change). A cross-tenant id is refused as
    // not-found, the same answer sendNowForSession has always given — but only
    // after a coarse gate, so a caller with no booking.update at all is refused
    // before the lookup and cannot tell a real id from an unknown one.
    requirePermission(
      ctx,
      'booking.update',
      { organizationId: ctx.activeOrganizationId! },
      'reminders',
    );
    const resource = await resolveAppointmentResource(appointmentId, ctx.activeOrganizationId!);
    if (!resource) throw new InvalidInputError('appointment not found');
    requirePermission(ctx, 'booking.update', resource, 'reminders');
    const reports = await sendNowForSession(ctxToSession(ctx), appointmentId);
    return { reports };
  });
}
