import { ctxToSession } from '@/lib/auth';
import {
  can,
  requireAuthContext,
  requirePagePermission,
  scopedByOwn,
  scopedLocationIds,
} from '@/lib/rbac';
import { currentLocalYearMonth, localMonthRange, MONTH_PARAM_RE } from '@/lib/tz';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { loadLocationsForOrg } from '@/lib/active-location';
import { toAppointmentDto } from '@/lib/appointments';
import SchedulerView from '@/components/scheduler/SchedulerView';
import ReschedulePanel from '@/components/scheduler/ReschedulePanel';

export const metadata = { title: 'Scheduler · Bookpitch' };

export default async function SchedulerPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const ctx = await requireAuthContext();
  requirePagePermission(
    ctx,
    'booking.read',
    { organizationId: ctx.activeOrganizationId! },
    'appointments',
  );
  const session = ctxToSession(ctx);
  const { active } = await loadLocationsForOrg(session.organizationId);
  const tz = active.timezone ?? 'UTC';

  const raw = (await searchParams).month;
  const requested = Array.isArray(raw) ? raw[0] : raw;
  const yearMonth =
    typeof requested === 'string' && MONTH_PARAM_RE.test(requested)
      ? requested
      : currentLocalYearMonth(tz);
  const { anchorLocalDate, start: monthStart, end: monthEnd } = localMonthRange(yearMonth, tz);
  const spanDays = (monthEnd.getTime() - monthStart.getTime()) / 86_400_000;
  if (spanDays > 62) {
    throw new Error(`scheduler range of ${spanDays}d exceeds the 62d bound`);
  }

  const scoped = await scopedLocationIds(ctx);
  const ownUserId = scopedByOwn(ctx, 'booking.read');
  const ownFilter = ownUserId ? { staff: { userId: ownUserId } } : {};
  const locationInScope = !scoped || scoped.includes(active.id);

  // U-02: the booking modal hard-coded "$". The organisation's own currency
  // column is authoritative — GEL for this deployment — so it is read here and
  // formatted with lib/i18n formatCurrency() rather than concatenated.
  const orgCurrency = await withOrg(session.organizationId, async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: session.organizationId },
      select: { currency: true },
    });
    return org.currency;
  });

  const { staff, services, customers, appointments } = await withOrg(
    session.organizationId,
    async (tx) => {
      const [staff, services, customers, rows] = await Promise.all([
        tx.staff.findMany({
          where: { locationId: active.id },
          select: {
            id: true,
            name: true,
            roleTitle: true,
            specialty: true,
            calendarColor: true,
          },
          orderBy: { name: 'asc' },
        }),
        tx.service.findMany({
          where: { locationId: active.id, isActive: true },
          select: { id: true, name: true, price: true, durationMinutes: true },
          orderBy: { name: 'asc' },
        }),
        tx.customer.findMany({
          select: { id: true, name: true, phone: true },
          orderBy: { name: 'asc' },
        }),
        locationInScope
          ? tx.appointment.findMany({
              where: {
                locationId: active.id,
                ...ownFilter,
                startsAt: { gte: monthStart, lt: monthEnd },
              },
              include: {
                customer: {
                  select: {
                    id: true,
                    name: true,
                    phone: true,
                    avatarUrl: true,
                  },
                },
                staff: {
                  select: {
                    id: true,
                    name: true,
                    roleTitle: true,
                    calendarColor: true,
                  },
                },
              },
              orderBy: { startsAt: 'asc' },
            })
          : Promise.resolve([]),
      ]);
      await writeAudit(tx, session, 'list', 'appointment', null, {
        count: rows.length,
        locationId: active.id,
      });
      return {
        staff,
        services: services.map((s) => ({ ...s, price: Number(s.price) })),
        customers,
        appointments: rows.map((r) => toAppointmentDto(r, tz)),
      };
    },
  );

  // This list-mode check controls only whether the workflow is rendered. Every
  // slot lookup and the final mutation resolve + authorise the exact appointment
  // resource again, so :own and :branch callers never rely on this broad check.
  const canReschedule = can(ctx, 'booking.update', {
    organizationId: session.organizationId,
  });

  return (
    <div className="space-y-6">
      <SchedulerView
        location={{
          id: active.id,
          name: active.name,
          type: active.type,
          timezone: tz,
        }}
        staff={staff}
        services={services}
        customers={customers}
        appointments={appointments}
        currency={orgCurrency}
        monthAnchor={anchorLocalDate}
      />
      {canReschedule && <ReschedulePanel appointments={appointments} staff={staff} timezone={tz} />}
    </div>
  );
}
