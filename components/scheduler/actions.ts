'use server';

import { revalidatePath } from 'next/cache';
import { requireRole, SlotTakenError } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { notifyEvent } from '@/lib/notifications';
import {
  assertCustomerInOrg,
  assertStaffAtLocation,
  assertWithinAvailability,
  isExclusionViolation,
  loadServiceForLocation,
  parseCreateInput,
  parseUpdateInput,
  toAppointmentDto,
  type AppointmentCreateInput,
  type AppointmentUpdateInput,
} from '@/lib/appointments';

// Mirror the /api/appointments endpoints but skip the HTTP hop for internal
// UI callers. Same withOrg + writeAudit pattern. revalidatePath refreshes
// the server-rendered scheduler list.

export async function bookAppointmentAction(input: AppointmentCreateInput) {
  const session = await requireRole('owner', 'practitioner', 'receptionist');
  const parsed = parseCreateInput(input);
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
    return appointment;
  } catch (err) {
    if (isExclusionViolation(err)) throw new SlotTakenError();
    throw err;
  }
}

export async function updateAppointmentAction(id: string, input: AppointmentUpdateInput) {
  const session = await requireRole('owner', 'practitioner', 'receptionist');
  const parsed = parseUpdateInput(input);

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

      // Only broadcast on meaningful status transitions — otherwise the feed
      // is noisy on every notes edit.
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
    return appointment;
  } catch (err) {
    if (isExclusionViolation(err)) throw new SlotTakenError();
    throw err;
  }
}
