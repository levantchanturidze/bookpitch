import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { InvalidInputError, ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission, scopedLocationIds, scopedByOwn } from '@/lib/rbac';
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
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'booking.read',
      { organizationId: ctx.activeOrganizationId! },
      'appointments',
    );
    const session = ctxToSession(ctx);
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

    // Phase 6: branch scoping. When the caller has populated
    // ctx.branchIds (BRANCH_MANAGER), constrain the query to the
    // location IDs those branches correspond to — otherwise a
    // parameter-less list would leak every branch's data.
    const scoped = await scopedLocationIds(ctx);
    if (scoped && locationId && !scoped.includes(locationId)) {
      throw new InvalidInputError('locationId is outside your branch scope');
    }
    const locationFilter = locationId
      ? { locationId }
      : scoped
        ? { locationId: { in: scoped } }
        : {};

    // F-09 fix: :own-scoped roles (PROVIDER's `booking.read:own`) MUST see
    // only their own bookings. can() grants the call in list mode; the
    // filter has to live at the query layer. Filter matches
    // appointment.staff.userId to the caller's user id.
    const ownUserId = scopedByOwn(ctx, 'booking.read');
    const ownFilter = ownUserId ? { staff: { userId: ownUserId } } : {};

    const appointments = await withOrg(session.organizationId, async (tx) => {
      const rows = await tx.appointment.findMany({
        where: {
          ...locationFilter,
          ...ownFilter,
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
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'booking.create',
      { organizationId: ctx.activeOrganizationId! },
      'appointments',
    );
    const session = ctxToSession(ctx);
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
