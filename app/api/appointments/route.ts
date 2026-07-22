import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { InvalidInputError, requireRole, withApi } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import {
  SlotTakenError,
  assertCustomerInOrg,
  assertStaffAtLocation,
  assertWithinAvailability,
  isExclusionViolation,
  loadServiceForLocation,
  parseCreateInput,
  toAppointmentDto,
} from '@/lib/appointments';

// -----------------------------------------------------------------------------
// GET /api/appointments?locationId=&from=&to=
// -----------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  return withApi(async () => {
    const session = await requireRole('owner', 'practitioner', 'receptionist');
    const url = new URL(req.url);
    const locationId = url.searchParams.get('locationId') ?? undefined;
    const from = url.searchParams.get('from'); // ISO
    const to = url.searchParams.get('to');
    if (!from || !to) throw new InvalidInputError('from and to are required');

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new InvalidInputError('from/to must be ISO dates');
    }

    const appointments = await withOrg(session.organizationId, async (tx) => {
      const rows = await tx.appointment.findMany({
        where: {
          ...(locationId ? { locationId } : {}),
          startsAt: { gte: fromDate, lt: toDate },
        },
        include: {
          customer: { select: { id: true, name: true, phone: true, avatarUrl: true } },
          staff: {
            select: { id: true, name: true, roleTitle: true, calendarColor: true },
          },
        },
        orderBy: { startsAt: 'asc' },
      });
      await writeAudit(tx, session, 'list', 'appointment', null, {
        count: rows.length,
        locationId: locationId ?? null,
      });
      return rows.map(toAppointmentDto);
    });

    return { appointments };
  });
}

// -----------------------------------------------------------------------------
// POST /api/appointments  → create with snapshotted service_name + price
// -----------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireRole('owner', 'practitioner', 'receptionist');
    const input = parseCreateInput(await req.json().catch(() => null));

    const startsAt = new Date(input.startsAt);
    try {
      const appointment = await withOrg(session.organizationId, async (tx) => {
        await assertStaffAtLocation(tx, input.locationId, input.staffId);
        await assertCustomerInOrg(tx, input.customerId);
        const service = await loadServiceForLocation(tx, input.locationId, input.serviceId);
        const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);
        await assertWithinAvailability(tx, input.staffId, startsAt, endsAt);

        const row = await tx.appointment.create({
          data: {
            organizationId: session.organizationId,
            locationId: input.locationId,
            customerId: input.customerId,
            staffId: input.staffId,
            serviceId: service.id,
            startsAt,
            endsAt,
            serviceName: service.name, // SNAPSHOT
            price: service.price, // SNAPSHOT
            status: 'pending',
            paymentStatus: 'unpaid',
            notes: input.notes,
            createdBy: session.userId,
          },
          include: {
            customer: { select: { id: true, name: true, phone: true, avatarUrl: true } },
            staff: { select: { id: true, name: true, roleTitle: true, calendarColor: true } },
          },
        });
        await writeAudit(tx, session, 'create', 'appointment', row.id);
        return toAppointmentDto(row);
      });
      return { appointment };
    } catch (err) {
      if (isExclusionViolation(err)) throw new SlotTakenError();
      throw err;
    }
  }).then((r) => r);
}
