import type { NextRequest } from 'next/server';
import { ctxToSession, NotFoundError, SlotTakenError, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { resolveAppointmentResource } from '@/lib/rbac/scope';
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
    const raw = (await req
      .clone()
      .json()
      .catch(() => null)) as { status?: unknown } | null;
    const requiredPerm = raw?.status === 'cancelled' ? 'booking.cancel' : 'booking.update';
    const session = ctxToSession(ctx);
    const { id } = await params;
    // Resolve the concrete resource before the permission check, so `:own` AND
    // `:branch` are both evaluated against this appointment rather than falling
    // through can()'s list-mode fallback.
    //
    // F-09 fixed the owner half here and left the branch half: this passed
    // `{ organizationId, ownerUserId }` with no branchId, so a `:branch`-scoped
    // caller still matched can()'s `!resource?.branchId` fallback and could
    // PATCH an appointment in a branch they do not hold. Both facts live on the
    // same row; fetching them separately only created the chance to forget one.
    const resource = await resolveAppointmentResource(id, ctx.activeOrganizationId!);
    // Same shape the rest of this handler uses for a missing row (line ~127),
    // so a cross-tenant id and a deleted one are indistinguishable to the caller.
    if (!resource) throw new NotFoundError('appointment not found');
    requirePermission(ctx, requiredPerm, resource, 'appointments');
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

        // SEC-007: inline the waitlist fan-out inside the same
        // tenant-scoped tx so notifyWaitlistForCancelled runs against RLS.
        // Previously called after the tx closed via withoutRls — worked,
        // but was the "org-scoped WHERE on superuser client" shape.
        if (input.status === 'cancelled') {
          try {
            await notifyWaitlistForCancelled(tx, session.organizationId, {
              id: row.id,
              staffId: row.staffId,
              serviceId: row.serviceId,
              locationId: row.locationId,
              startsAt: row.startsAt,
              endsAt: row.endsAt,
            });
          } catch {
            /* swallow — audit + retention are unaffected */
          }
        }
        return toAppointmentDto(row);
      });

      if (!appointment) throw new NotFoundError('appointment not found');

      return { appointment };
    } catch (err) {
      if (isExclusionViolation(err)) throw new SlotTakenError();
      throw err;
    }
  });
}
