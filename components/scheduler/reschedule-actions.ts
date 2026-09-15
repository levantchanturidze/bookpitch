'use server';

import { ctxToSession } from '@/lib/auth';
import { getAvailableSlots } from '@/lib/appointments';
import { withOrg } from '@/lib/db';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { appointmentResource } from '@/lib/rbac/scope';

export type RescheduleSlotsResult =
  | { ok: true; slots: string[] }
  | { ok: false; error: 'invalid_request' | 'appointment_not_found' | 'staff_not_at_location' };

const UUID_RE = /^[0-9a-f-]{36}$/i;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validLocalDate(value: string): boolean {
  if (!LOCAL_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Slot lookup for an EXISTING appointment.
 *
 * This is deliberately separate from fetchAvailableSlotsAction(). A caller may
 * not supply an arbitrary id to the ordinary booking picker and make another
 * appointment disappear from occupancy. We first resolve the named appointment
 * inside the active tenant, authorise booking.update against that exact
 * owner/branch resource, then exclude only that row from occupancy.
 *
 * Duration is derived from the persisted appointment, never trusted from the
 * browser. Otherwise a caller could ask for five-minute availability for a
 * sixty-minute booking and make the picker disagree with the write path again.
 */
export async function fetchRescheduleSlotsAction(
  appointmentId: string,
  staffId: string,
  date: string,
): Promise<RescheduleSlotsResult> {
  if (!UUID_RE.test(appointmentId) || !UUID_RE.test(staffId) || !validLocalDate(date)) {
    return { ok: false, error: 'invalid_request' };
  }

  const ctx = await requireAuthContext();
  const session = ctxToSession(ctx);

  const target = await withOrg(session.organizationId, (tx) =>
    tx.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        locationId: true,
        startsAt: true,
        endsAt: true,
        staff: { select: { userId: true } },
      },
    }),
  );
  if (!target) return { ok: false, error: 'appointment_not_found' };

  requirePermission(
    ctx,
    'booking.update',
    appointmentResource(session.organizationId, {
      locationId: target.locationId,
      ownerUserId: target.staff?.userId ?? null,
    }),
    'appointments',
  );

  const durationMinutes = Math.round(
    (target.endsAt.getTime() - target.startsAt.getTime()) / 60_000,
  );
  if (durationMinutes <= 0 || durationMinutes > 24 * 60) {
    return { ok: false, error: 'invalid_request' };
  }

  return withOrg(session.organizationId, async (tx) => {
    const candidate = await tx.staff.findFirst({
      where: { id: staffId, locationId: target.locationId },
      select: { location: { select: { timezone: true } } },
    });
    if (!candidate) return { ok: false, error: 'staff_not_at_location' } as const;

    const slots = await getAvailableSlots(
      tx,
      staffId,
      date,
      durationMinutes,
      candidate.location.timezone ?? 'UTC',
      target.id,
    );
    return { ok: true, slots } as const;
  });
}
