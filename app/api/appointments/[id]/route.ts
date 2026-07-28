import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ctxToSession, SlotTakenError, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import {
  assertStaffAtLocation,
  assertWithinAvailability,
  isExclusionViolation,
  loadServiceForLocation,
  parseUpdateInput,
  toAppointmentDto,
} from '@/lib/appointments';
import { notifyWaitlistForCancelled } from '@/lib/waitlist';

// PATCH /api/appointments/[id]
// Reschedule (startsAt / staffId / serviceId), or status/paymentStatus changes.
// Cancel = PATCH { status: 'cancelled' }. All in one endpoint by design so the
// double-booking guard reruns on every write that could conflict.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    // Cancel = PATCH { status: 'cancelled' } — use the stronger cancel perm
    // when the caller is trying to cancel. Otherwise it's an update. We pass
    // the BASE key (no scope suffix); can() walks :org → :branch → :own.
    const raw = (await req.clone().json().catch(() => null)) as { status?: unknown } | null;
    const requiredPerm = raw?.status === 'cancelled' ? 'booking.cancel' : 'booking.update';
    requirePermission(ctx, requiredPerm, { organizationId: ctx.activeOrganizationId! }, 'appointments');
    const session = ctxToSession(ctx);
    const { id } = await params;
    const input = parseUpdateInput(await req.json().catch(() => null));

    try {
      const appointment = await withOrg(session.organizationId, async (tx) => {
        const existing = await tx.appointment.findUnique({ where: { id } });
        if (!existing) return null;

        // Compute the new state (merging existing + input) so we can validate
        // availability and recompute ends_at on staff/service/starts changes.
        const nextStaffId = input.staffId ?? existing.staffId;
        const nextStartsAt = input.startsAt ? new Date(input.startsAt) : existing.startsAt;
        let nextEndsAt = existing.endsAt;
        let nextServiceName = existing.serviceName;
        let nextPrice = existing.price;
        let nextServiceId = existing.serviceId;

        if (input.serviceId && input.serviceId !== existing.serviceId) {
          const service = await loadServiceForLocation(tx, existing.locationId, input.serviceId);
          nextServiceId = service.id;
          nextServiceName = service.name;
          nextPrice = service.price;
          nextEndsAt = new Date(nextStartsAt.getTime() + service.durationMinutes * 60_000);
        } else if (input.startsAt) {
          // Preserve original duration on a plain reschedule.
          const dur = existing.endsAt.getTime() - existing.startsAt.getTime();
          nextEndsAt = new Date(nextStartsAt.getTime() + dur);
        }

        // Availability check only when the slot actually moves or staff changes.
        if (input.startsAt || (input.staffId && input.staffId !== existing.staffId)) {
          await assertStaffAtLocation(tx, existing.locationId, nextStaffId);
          await assertWithinAvailability(tx, nextStaffId, nextStartsAt, nextEndsAt);
        }

        const row = await tx.appointment.update({
          where: { id },
          data: {
            staffId: nextStaffId,
            startsAt: nextStartsAt,
            endsAt: nextEndsAt,
            serviceId: nextServiceId,
            serviceName: nextServiceName,
            price: nextPrice,
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.paymentStatus !== undefined ? { paymentStatus: input.paymentStatus } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            ...(input.icd10Code !== undefined ? { icd10Code: input.icd10Code } : {}),
            ...(input.icd10Description !== undefined
              ? { icd10Description: input.icd10Description }
              : {}),
          },
          include: {
            customer: { select: { id: true, name: true, phone: true, avatarUrl: true } },
            staff: { select: { id: true, name: true, roleTitle: true, calendarColor: true } },
          },
        });

        const changedFields = Object.keys(input);
        await writeAudit(tx, session, 'update', 'appointment', id, { fields: changedFields });
        return toAppointmentDto(row);
      });

      if (!appointment) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      // Cancel-transition fan-out: notify anyone waiting on this slot.
      // Fire-and-catch — a waitlist failure never blocks the cancel.
      if (input.status === 'cancelled') {
        try {
          await notifyWaitlistForCancelled(session.organizationId, {
            id: appointment.id,
            staffId: appointment.staffId,
            serviceId: appointment.serviceId,
            locationId: appointment.locationId,
            startsAt: new Date(appointment.startsAt),
            endsAt: new Date(appointment.endsAt),
          });
        } catch {
          /* swallow — audit + retention are unaffected */
        }
      }

      return { appointment };
    } catch (err) {
      if (isExclusionViolation(err)) throw new SlotTakenError();
      throw err;
    }
  });
}
