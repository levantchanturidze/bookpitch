import { ctxToSession } from '@/lib/auth';
import {
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

export const metadata = { title: 'Scheduler · Bookpitch' };

// Server component: fetches the whole month's appointments + supporting
// staff/services/customers for the active location, then hands off to the
// client SchedulerView. Server Actions revalidate this route after each write.
export default async function SchedulerPage({
  searchParams,
}: {
  // Next resolves searchParams asynchronously in this version — it is a Promise
  // and must be awaited before any property is read.
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

  // 5.4 — the month on screen is ROUTE state, so previous/next re-render on the
  // server with that month's appointments. It used to be client-only `useState`
  // seeded once from a prop: navigating changed the heading and the grid, and
  // silently kept showing the first month's rows.
  //
  // An unparseable or out-of-range value is normalised to the current local
  // month rather than rejected — a bad ?month= in a shared link should open the
  // scheduler, not a 400 — but it is normalised against a strict regex, so
  // nothing unvalidated reaches the date maths.
  const raw = (await searchParams).month;
  const requested = Array.isArray(raw) ? raw[0] : raw;
  const yearMonth =
    typeof requested === 'string' && MONTH_PARAM_RE.test(requested)
      ? requested
      : currentLocalYearMonth(tz);

  // Query boundary and display anchor are now two values, because they answer
  // two questions. Reusing one for both is what put "August 2026" above a
  // September calendar on 2026-09-15.
  const { anchorLocalDate, start: monthStart, end: monthEnd } = localMonthRange(yearMonth, tz);

  // The repository's bounded-range invariant: never let a single scheduler read
  // span more than 62 days, whatever arrives in the URL. A calendar month
  // cannot exceed 31 days, so this can only fire if the helper above is ever
  // changed to something wider — which is exactly when it should.
  const spanDays = (monthEnd.getTime() - monthStart.getTime()) / 86_400_000;
  if (spanDays > 62) throw new Error(`scheduler range of ${spanDays}d exceeds the 62d bound`);

  // 5.2 — the SSR list had NO scope filter at all, so a PROVIDER holding only
  // booking.read:own saw the whole location's day on first paint, and a
  // BRANCH_MANAGER saw locations outside their branches. can() grants the call
  // in list mode and trusts the query to filter; this is that query, and it was
  // not filtering. /api/appointments has done this since F-09 — the server
  // render simply never did.
  const scoped = await scopedLocationIds(ctx);
  const ownUserId = scopedByOwn(ctx, 'booking.read');
  const ownFilter = ownUserId ? { staff: { userId: ownUserId } } : {};
  const locationInScope = !scoped || scoped.includes(active.id);

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
        // A BRANCH_MANAGER whose active location is outside their branches gets
        // an empty day, not everyone else's. Returning [] rather than throwing
        // keeps the page usable while they switch location.
        locationInScope
          ? tx.appointment.findMany({
              where: {
                locationId: active.id,
                ...ownFilter,
                startsAt: { gte: monthStart, lt: monthEnd },
              },
              include: {
                customer: { select: { id: true, name: true, phone: true, avatarUrl: true } },
                staff: { select: { id: true, name: true, roleTitle: true, calendarColor: true } },
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

  return (
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
      monthAnchor={anchorLocalDate}
    />
  );
}
