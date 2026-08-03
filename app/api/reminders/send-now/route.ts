import type { NextRequest } from 'next/server';
import { InvalidInputError, ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission, resolveBookingOwner } from '@/lib/rbac';
import { sendNowForSession } from '@/lib/messaging/reminders';

// POST /api/reminders/send-now  Body: { appointmentId: string }
// Bypasses the lead-time window but still honours per-channel idempotency.
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const body = (await req.json().catch(() => null)) as { appointmentId?: unknown } | null;
    const appointmentId = typeof body?.appointmentId === 'string' ? body.appointmentId : '';
    if (!appointmentId) throw new InvalidInputError('appointmentId is required');
    // F-09 companion: resolve booking owner so :own-scoped roles are
    // evaluated against the actual owner rather than can()'s list-mode fallback.
    const ownerUserId = await resolveBookingOwner(appointmentId, ctx.activeOrganizationId!);
    requirePermission(
      ctx, 'booking.update',
      { organizationId: ctx.activeOrganizationId!, ownerUserId: ownerUserId ?? undefined },
      'reminders',
    );
    const reports = await sendNowForSession(ctxToSession(ctx), appointmentId);
    return { reports };
  });
}
