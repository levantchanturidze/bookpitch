'use server';

import { revalidatePath } from 'next/cache';
import { ctxToSession, InvalidInputError, SlotTakenError } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { notifyEvent } from '@/lib/notifications';
import {
  assertCustomerInOrg,
  assertStaffAtLocation,
  assertWithinAvailability,
  getAvailableSlots,
  isExclusionViolation,
  loadServiceForLocation,
  parseCreateInput,
  parseUpdateInput,
  toAppointmentDto,
  type AppointmentCreateInput,
  type AppointmentUpdateInput,
  type AppointmentDto,
} from '@/lib/appointments';
import { draftAppointment, type DraftAppointmentResult } from '@/lib/assistant/draft';

// -----------------------------------------------------------------------------
// Return-value types for expected errors.
//
// Next.js 16: "For expected errors, avoid using try/catch blocks and throw
// errors. Instead, model expected errors as return values." Throwing from a
// Server Action propagates to the nearest error boundary, not to the
// try/catch in the startTransition callback.
// -----------------------------------------------------------------------------
export type BookActionResult =
  | { ok: true; appointment: AppointmentDto }
  | { ok: false; error: string };

export type UpdateActionResult =
  | { ok: true; appointment: AppointmentDto | null }
  | { ok: false; error: string };

// Mirror the /api/appointments endpoints but skip the HTTP hop for internal
// UI callers. Same withOrg + writeAudit pattern. revalidatePath refreshes
// the server-rendered scheduler list.

export async function bookAppointmentAction(
  input: AppointmentCreateInput,
): Promise<BookActionResult> {
  const ctx = await requireAuthContext();
  requirePermission(
    ctx,
    'booking.create',
    { organizationId: ctx.activeOrganizationId! },
    'appointments',
  );
  const session = ctxToSession(ctx);
  let parsed: AppointmentCreateInput;
  try {
    parsed = parseCreateInput(input);
  } catch (err) {
    if (err instanceof InvalidInputError) return { ok: false, error: err.message };
    throw err;
  }
  const startsAt = new Date(parsed.startsAt);

  try {
    const appointment = await withOrg(session.organizationId, async (tx) => {
      await assertStaffAtLocation(tx, parsed.locationId, parsed.staffId);
      await assertCustomerInOrg(tx, parsed.customerId);
      const service = await loadServiceForLocation(tx, parsed.locationId, parsed.serviceId);
      const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);
      await assertWithinAvailability(tx, parsed.staffId, startsAt, endsAt);

      const row = await tx.appointment.create({
        data: {
          organizationId: session.organizationId,
          locationId: parsed.locationId,
          customerId: parsed.customerId,
          staffId: parsed.staffId,
          serviceId: service.id,
          startsAt,
          endsAt,
          serviceName: service.name,
          price: service.price,
          status: 'pending',
          paymentStatus: 'unpaid',
          notes: parsed.notes,
          createdBy: session.userId,
        },
        include: {
          customer: { select: { id: true, name: true, phone: true, avatarUrl: true } },
          staff: { select: { id: true, name: true, roleTitle: true, calendarColor: true } },
        },
      });
      await writeAudit(tx, session, 'create', 'appointment', row.id);
      await notifyEvent(tx, session.organizationId, {
        type: 'booking',
        title: 'New appointment booked',
        body: `${row.customer.name} · ${row.serviceName} with ${row.staff.name} on ${row.startsAt.toISOString().slice(0, 10)} at ${row.startsAt.toISOString().slice(11, 16)}`,
      });
      return toAppointmentDto(row);
    });
    revalidatePath('/scheduler');
    return { ok: true, appointment };
  } catch (err) {
    if (isExclusionViolation(err) || err instanceof SlotTakenError) {
      return { ok: false, error: 'slot_taken' };
    }
    if (err instanceof InvalidInputError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function updateAppointmentAction(
  id: string,
  input: AppointmentUpdateInput,
): Promise<UpdateActionResult> {
  const ctx = await requireAuthContext();
  let parsed: AppointmentUpdateInput;
  try {
    parsed = parseUpdateInput(input);
  } catch (err) {
    if (err instanceof InvalidInputError) return { ok: false, error: err.message };
    throw err;
  }
  // Cancel transitions warrant the stronger cancel permission.
  const needed = parsed.status === 'cancelled' ? 'booking.cancel' : 'booking.update';
  requirePermission(ctx, needed, { organizationId: ctx.activeOrganizationId! }, 'appointments');
  const session = ctxToSession(ctx);

  try {
    const appointment = await withOrg(session.organizationId, async (tx) => {
      const existing = await tx.appointment.findUnique({ where: { id } });
      if (!existing) return null;

      const nextStaffId = parsed.staffId ?? existing.staffId;
      const nextStartsAt = parsed.startsAt ? new Date(parsed.startsAt) : existing.startsAt;
      let nextEndsAt = existing.endsAt;
      let nextServiceName = existing.serviceName;
      let nextPrice = existing.price;
      let nextServiceId = existing.serviceId;

      if (parsed.serviceId && parsed.serviceId !== existing.serviceId) {
        const service = await loadServiceForLocation(tx, existing.locationId, parsed.serviceId);
        nextServiceId = service.id;
        nextServiceName = service.name;
        nextPrice = service.price;
        nextEndsAt = new Date(nextStartsAt.getTime() + service.durationMinutes * 60_000);
      } else if (parsed.startsAt) {
        const dur = existing.endsAt.getTime() - existing.startsAt.getTime();
        nextEndsAt = new Date(nextStartsAt.getTime() + dur);
      }

      if (parsed.startsAt || (parsed.staffId && parsed.staffId !== existing.staffId)) {
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
          ...(parsed.status !== undefined ? { status: parsed.status } : {}),
          ...(parsed.paymentStatus !== undefined ? { paymentStatus: parsed.paymentStatus } : {}),
          ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
        },
        include: {
          customer: { select: { id: true, name: true, phone: true, avatarUrl: true } },
          staff: { select: { id: true, name: true, roleTitle: true, calendarColor: true } },
        },
      });

      await writeAudit(tx, session, 'update', 'appointment', id, {
        fields: Object.keys(parsed),
      });

      if (parsed.status && parsed.status !== existing.status) {
        await notifyEvent(tx, session.organizationId, {
          type: 'booking',
          title: `Appointment ${parsed.status}`,
          body: `${row.customer.name} · ${row.serviceName} with ${row.staff.name}`,
        });
      }
      return toAppointmentDto(row);
    });
    if (appointment) revalidatePath('/scheduler');
    return { ok: true, appointment };
  } catch (err) {
    if (isExclusionViolation(err) || err instanceof SlotTakenError) {
      return { ok: false, error: 'slot_taken' };
    }
    if (err instanceof InvalidInputError) return { ok: false, error: err.message };
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Read-only slot availability — returns open 30-minute HH:MM UTC strings for
// the booking form slot picker. Uses booking.read permission (same as the
// GET /api/appointments endpoint). Not a mutation; no revalidatePath needed.
// -----------------------------------------------------------------------------
export async function fetchAvailableSlotsAction(
  staffId: string,
  date: string, // YYYY-MM-DD
  durationMinutes: number,
): Promise<string[]> {
  const ctx = await requireAuthContext();
  requirePermission(
    ctx,
    'booking.read',
    { organizationId: ctx.activeOrganizationId! },
    'appointments',
  );
  const session = ctxToSession(ctx);
  return withOrg(session.organizationId, (tx) =>
    getAvailableSlots(tx, staffId, date, durationMinutes),
  );
}

// -----------------------------------------------------------------------------
// Natural-language assistant — turns a prompt into a validated draft the UI
// pre-fills. Actual booking still goes through bookAppointmentAction so the
// GiST exclusion constraint stays the source of truth.
// -----------------------------------------------------------------------------
export async function draftAppointmentAction(
  locationId: string,
  prompt: string,
): Promise<DraftAppointmentResult> {
  const ctx = await requireAuthContext();
  requirePermission(
    ctx,
    'client.read:contact',
    { organizationId: ctx.activeOrganizationId! },
    'assistant',
  );
  return draftAppointment(ctxToSession(ctx), locationId, prompt);
}
