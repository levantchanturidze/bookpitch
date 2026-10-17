'use server';

import { type ActionErrorCode, type ActionResult } from '@/lib/action-result';
import { safeAction } from '@/lib/safe-action';

import { revalidatePath } from 'next/cache';
import { ctxToSession, InvalidInputError, SlotTakenError } from '@/lib/auth';
import {
  requireAuthContext,
  requirePermission,
  resolveAppointmentResource,
  resolveStaffResource,
} from '@/lib/rbac';
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
import { toLocalDate, toLocalTimeHHMM } from '@/lib/tz';

// -----------------------------------------------------------------------------
// Return-value types for expected errors.
//
// Next.js 16: "For expected errors, avoid using try/catch blocks and throw
// errors. Instead, model expected errors as return values." Throwing from a
// Server Action propagates to the nearest error boundary, not to the
// try/catch in the startTransition callback.
// -----------------------------------------------------------------------------
// `code` is present on failures that came through safeAction (refusals and
// unexpected errors); the domain failures these actions always returned —
// 'slot_taken', availability, invalid input — keep their `error` string, which
// is what the clients branch on.
export type BookActionResult =
  { ok: true; appointment: AppointmentDto } | { ok: false; error: string; code?: ActionErrorCode };

export type UpdateActionResult =
  | { ok: true; appointment: AppointmentDto | null }
  | { ok: false; error: string; code?: ActionErrorCode };

// Mirror the /api/appointments endpoints but skip the HTTP hop for internal
// UI callers. Same withOrg + writeAudit pattern. revalidatePath refreshes
// the server-rendered scheduler list.

async function bookAppointmentImpl(input: AppointmentCreateInput): Promise<BookActionResult> {
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
      const loc = await tx.location.findUnique({
        where: { id: parsed.locationId },
        select: { timezone: true },
      });
      const tz = loc?.timezone ?? 'UTC';
      await notifyEvent(tx, session.organizationId, {
        type: 'booking',
        title: 'New appointment booked',
        body: `${row.customer.name} · ${row.serviceName} with ${row.staff.name} on ${toLocalDate(row.startsAt, tz)} at ${toLocalTimeHHMM(row.startsAt, tz)}`,
      });
      return toAppointmentDto(row, tz);
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

async function updateAppointmentImpl(
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
  const session = ctxToSession(ctx);

  // RESOLVE THE RESOURCE BEFORE AUTHORISING IT.
  //
  // This used to be `requirePermission(ctx, needed, { organizationId }, …)`
  // followed by the load. `can()` grants `:own` and `:branch` when no owner or
  // branch is supplied — that is LIST mode, and it is deliberate — so a
  // mutation naming no resource took the list-mode path and every `:own` and
  // `:branch` caller could update ANY appointment in the organisation by
  // passing its id. Tenant isolation held; scope inside the tenant did not.
  //
  // The read is tenant-scoped via withOrg, so a cross-tenant id resolves to
  // null here and is refused as not-found without ever reaching can(). The
  // resolver supplies the owner AND the branch of the appointment's location
  // — a branch id, which is what ctx.branchIds holds (scoped-RBAC audit §3.4).
  const resource = await resolveAppointmentResource(id, session.organizationId);
  if (!resource) return { ok: true, appointment: null };

  requirePermission(ctx, needed, resource, 'appointments');

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
      const loc = await tx.location.findUnique({
        where: { id: existing.locationId },
        select: { timezone: true },
      });
      return toAppointmentDto(row, loc?.timezone ?? 'UTC');
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
// Read-only slot availability — returns open HH:MM strings IN THE LOCATION'S
// LOCAL TIMEZONE for the booking form slot picker. The date parameter is also
// a local YYYY-MM-DD in that timezone. Uses booking.read permission (same as
// GET /api/appointments). Not a mutation; no revalidatePath needed.
// -----------------------------------------------------------------------------
async function fetchAvailableSlotsImpl(
  staffId: string,
  date: string, // YYYY-MM-DD in the location's local timezone
  durationMinutes: number,
): Promise<string[]> {
  const ctx = await requireAuthContext();
  // Coarse gate first, as before: a caller with no booking.read at all is
  // refused before anything is looked up, so an unknown id cannot be told
  // apart from a real one.
  requirePermission(
    ctx,
    'booking.read',
    { organizationId: ctx.activeOrganizationId! },
    'appointments',
  );
  const session = ctxToSession(ctx);
  // Then name the staff member's BRANCH, so a `:branch` caller cannot read the
  // occupancy of a branch they do not hold. The owner is deliberately NOT
  // named: `:own` stays in list mode here, exactly as before, because a
  // PROVIDER's booking form looks up slots for the practitioner being booked.
  const staffResource = await resolveStaffResource(staffId, session.organizationId);
  if (!staffResource) return [];
  requirePermission(
    ctx,
    'booking.read',
    { organizationId: session.organizationId, branchId: staffResource.branchId },
    'appointments',
  );
  return withOrg(session.organizationId, async (tx) => {
    // Load the staff member's location timezone so slots are in local time.
    const staffRec = await tx.staff.findUnique({
      where: { id: staffId },
      select: { location: { select: { timezone: true } } },
    });
    const tz = staffRec?.location.timezone ?? 'UTC';
    return getAvailableSlots(tx, staffId, date, durationMinutes, tz);
  });
}

// -----------------------------------------------------------------------------
// Natural-language assistant — turns a prompt into a validated draft the UI
// pre-fills. Actual booking still goes through bookAppointmentAction so the
// GiST exclusion constraint stays the source of truth.
// -----------------------------------------------------------------------------
export async function draftAppointmentAction(
  locationId: string,
  prompt: string,
): Promise<ActionResult<DraftAppointmentResult>> {
  return safeAction('scheduler.draftAppointment', async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'client.read:contact',
      { organizationId: ctx.activeOrganizationId! },
      'assistant',
    );
    // The assistant quota refusal (AssistantQuotaExceededError) extends
    // InvalidInputError, so it keeps its own message rather than collapsing
    // into the generic one.
    return draftAppointment(ctxToSession(ctx), locationId, prompt);
  });
}

// -----------------------------------------------------------------------------
// The exported Server Actions never throw.
//
// The bodies above throw their refusals — UnauthenticatedError from
// requireAuthContext(), ForbiddenError from requirePermission() — and rethrow
// anything they do not recognise. Out of a Server Action, either reached the
// browser as a masked error with a digest and an HTTP 500: a crafted call
// without the permission was refused, but looked like a crash (production C7
// UAT, 2026-10-01). safeAction() turns a refusal into a typed result and
// anything unexpected into the generic message, reported to Sentry. The
// bodies, and so the checks they run, are unchanged.
// -----------------------------------------------------------------------------

export async function bookAppointmentAction(
  input: AppointmentCreateInput,
): Promise<BookActionResult> {
  const r = await safeAction('scheduler.bookAppointment', () => bookAppointmentImpl(input));
  return r.ok ? r.data : { ok: false, error: r.message, code: r.code };
}

export async function updateAppointmentAction(
  id: string,
  input: AppointmentUpdateInput,
): Promise<UpdateActionResult> {
  const r = await safeAction('scheduler.updateAppointment', () => updateAppointmentImpl(id, input));
  return r.ok ? r.data : { ok: false, error: r.message, code: r.code };
}

/**
 * Open slots, or a typed refusal. It used to return the bare list and THROW
 * on a refusal, which the picker could only render as "no slots".
 */
export async function fetchAvailableSlotsAction(
  staffId: string,
  date: string,
  durationMinutes: number,
): Promise<ActionResult<string[]>> {
  return safeAction('scheduler.fetchAvailableSlots', () =>
    fetchAvailableSlotsImpl(staffId, date, durationMinutes),
  );
}
