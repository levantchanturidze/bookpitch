import type { PrismaClient } from '@prisma/client';
import type { ActiveSession } from '@/lib/auth';
import { withOrgReplica } from '@/lib/db';

// -----------------------------------------------------------------------------
// Analytics — single-transaction metric computation so every KPI on the page
// is self-consistent (no time drift between the revenue query and the
// occupancy query).
//
// All conventions per the P2.3 plan:
//   - Ref date: server "now" (UTC).
//   - Revenue = only paymentStatus='paid' appointments.
//   - Booked (for occupancy) = status in {confirmed, completed}.
//   - Trend = 7 days incl. today; bookingsPerStaff = last 7 days.
//   - Avg ticket = last 30 days of paid appointments.
//   - Timezone = UTC everywhere (matches P1.5).
// -----------------------------------------------------------------------------

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export type KpiDelta = {
  current: number;
  previous: number; // same weekday 7 days ago
  deltaPct: number | null; // null when previous = 0 (avoid div-by-zero)
};

export type TrendPoint = { date: string; revenue: number; bookings: number };
export type StaffBookings = { staffId: string; staffName: string; bookings: number };

export type RosterRow = {
  staffId: string;
  staffName: string;
  roleTitle: string;
  window: { start: string; end: string } | null; // null = off today
  availableMinutes: number;
  bookedMinutes: number;
  appointmentCount: number;
};

export type Metrics = {
  refDate: string;
  location: { id: string; name: string; type: 'clinic' | 'salon' };
  revenue: KpiDelta;
  bookings: KpiDelta;
  occupancy: { bookedMinutes: number; availableMinutes: number; percent: number | null };
  averageTicket: { amount: number; sinceDays: number; sampleSize: number };
  trend: TrendPoint[];
  bookingsPerStaff: StaffBookings[];
};

const BOOKED_STATUSES = ['confirmed', 'completed'] as const;
const NON_CANCELLED_STATUSES = ['pending', 'confirmed', 'completed'] as const;

function utcStartOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
}

function pctDelta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

// -----------------------------------------------------------------------------
// Sub-queries (each pass tx so they compose inside computeMetrics)
// -----------------------------------------------------------------------------

async function dailyRevenueOn(tx: TxClient, locationId: string, dayStart: Date): Promise<number> {
  const dayEnd = addDays(dayStart, 1);
  const rows = await tx.appointment.findMany({
    where: {
      locationId,
      paymentStatus: 'paid',
      startsAt: { gte: dayStart, lt: dayEnd },
    },
    select: { price: true },
  });
  return rows.reduce((sum, r) => sum + Number(r.price), 0);
}

async function dailyBookingCountOn(
  tx: TxClient,
  locationId: string,
  dayStart: Date,
): Promise<number> {
  const dayEnd = addDays(dayStart, 1);
  return tx.appointment.count({
    where: {
      locationId,
      status: { in: [...NON_CANCELLED_STATUSES] },
      startsAt: { gte: dayStart, lt: dayEnd },
    },
  });
}

async function occupancyOn(
  tx: TxClient,
  locationId: string,
  dayStart: Date,
): Promise<{ bookedMinutes: number; availableMinutes: number; percent: number | null }> {
  const dayEnd = addDays(dayStart, 1);
  const [staff, appts] = await Promise.all([
    tx.staff.findMany({
      where: { locationId },
      select: {
        id: true,
        availability: {
          where: { weekday: dayStart.getUTCDay() },
          select: { startTime: true, endTime: true },
        },
      },
    }),
    tx.appointment.findMany({
      where: {
        locationId,
        status: { in: [...BOOKED_STATUSES] },
        startsAt: { gte: dayStart, lt: dayEnd },
      },
      select: { startsAt: true, endsAt: true },
    }),
  ]);

  const availableMinutes = staff.reduce((sum, s) => {
    for (const w of s.availability) {
      const startMin = w.startTime.getUTCHours() * 60 + w.startTime.getUTCMinutes();
      const endMin = w.endTime.getUTCHours() * 60 + w.endTime.getUTCMinutes();
      sum += Math.max(0, endMin - startMin);
    }
    return sum;
  }, 0);

  const bookedMinutes = appts.reduce((sum, a) => sum + minutesBetween(a.startsAt, a.endsAt), 0);

  const percent = availableMinutes === 0 ? null : (bookedMinutes / availableMinutes) * 100;
  return { bookedMinutes, availableMinutes, percent };
}

async function averageTicket(
  tx: TxClient,
  locationId: string,
  sinceDays: number,
  refDate: Date,
): Promise<{ amount: number; sinceDays: number; sampleSize: number }> {
  const since = addDays(utcStartOfDay(refDate), -sinceDays + 1);
  const rows = await tx.appointment.findMany({
    where: {
      locationId,
      paymentStatus: 'paid',
      startsAt: { gte: since },
    },
    select: { price: true },
  });
  const total = rows.reduce((sum, r) => sum + Number(r.price), 0);
  return {
    amount: rows.length === 0 ? 0 : total / rows.length,
    sinceDays,
    sampleSize: rows.length,
  };
}

async function revenueTrend(
  tx: TxClient,
  locationId: string,
  days: number,
  refDate: Date,
): Promise<TrendPoint[]> {
  const start = addDays(utcStartOfDay(refDate), -days + 1);
  const end = addDays(utcStartOfDay(refDate), 1);
  const rows = await tx.appointment.findMany({
    where: {
      locationId,
      status: { in: [...NON_CANCELLED_STATUSES] },
      startsAt: { gte: start, lt: end },
    },
    select: { startsAt: true, price: true, paymentStatus: true },
  });
  // Bucket by UTC day.
  const buckets = new Map<string, { revenue: number; bookings: number }>();
  for (let i = 0; i < days; i++) {
    const day = utcDayKey(addDays(start, i));
    buckets.set(day, { revenue: 0, bookings: 0 });
  }
  for (const r of rows) {
    const key = utcDayKey(r.startsAt);
    const b = buckets.get(key);
    if (!b) continue;
    b.bookings += 1;
    if (r.paymentStatus === 'paid') b.revenue += Number(r.price);
  }
  return [...buckets.entries()].map(([date, v]) => ({ date, ...v }));
}

async function bookingsPerStaff(
  tx: TxClient,
  locationId: string,
  days: number,
  refDate: Date,
): Promise<StaffBookings[]> {
  const start = addDays(utcStartOfDay(refDate), -days + 1);
  const end = addDays(utcStartOfDay(refDate), 1);
  const grouped = await tx.appointment.groupBy({
    by: ['staffId'],
    where: {
      locationId,
      status: { in: [...NON_CANCELLED_STATUSES] },
      startsAt: { gte: start, lt: end },
    },
    _count: { staffId: true },
  });
  const staff = await tx.staff.findMany({
    where: { locationId, id: { in: grouped.map((g) => g.staffId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(staff.map((s) => [s.id, s.name]));
  return grouped
    .map((g) => ({
      staffId: g.staffId,
      staffName: nameById.get(g.staffId) ?? 'Unknown',
      bookings: g._count.staffId,
    }))
    .sort((a, b) => b.bookings - a.bookings);
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export async function computeMetrics(
  session: ActiveSession,
  locationId: string,
  refDate: Date = new Date(),
): Promise<Metrics> {
  return withOrgReplica(session.organizationId, async (tx) => {
    const location = await tx.location.findFirst({
      where: { id: locationId },
      select: { id: true, name: true, type: true },
    });
    if (!location) {
      throw new Error(`location ${locationId} not found (RLS or missing)`);
    }

    const today = utcStartOfDay(refDate);
    const sevenAgo = addDays(today, -7);

    const [revenueToday, revenuePrev, bookingsToday, bookingsPrev, occ, avg, trend, perStaff] =
      await Promise.all([
        dailyRevenueOn(tx, locationId, today),
        dailyRevenueOn(tx, locationId, sevenAgo),
        dailyBookingCountOn(tx, locationId, today),
        dailyBookingCountOn(tx, locationId, sevenAgo),
        occupancyOn(tx, locationId, today),
        averageTicket(tx, locationId, 30, refDate),
        revenueTrend(tx, locationId, 7, refDate),
        bookingsPerStaff(tx, locationId, 7, refDate),
      ]);

    return {
      refDate: utcDayKey(today),
      location,
      revenue: {
        current: revenueToday,
        previous: revenuePrev,
        deltaPct: pctDelta(revenueToday, revenuePrev),
      },
      bookings: {
        current: bookingsToday,
        previous: bookingsPrev,
        deltaPct: pctDelta(bookingsToday, bookingsPrev),
      },
      occupancy: occ,
      averageTicket: avg,
      trend,
      bookingsPerStaff: perStaff,
    };
  });
}

// -----------------------------------------------------------------------------
// Roster — separate function since the UI shows it alongside metrics.
// -----------------------------------------------------------------------------

export async function dailyRoster(
  session: ActiveSession,
  locationId: string,
  refDate: Date = new Date(),
): Promise<RosterRow[]> {
  return withOrgReplica(session.organizationId, async (tx) => {
    const day = utcStartOfDay(refDate);
    const dayEnd = addDays(day, 1);
    const weekday = day.getUTCDay();

    const staff = await tx.staff.findMany({
      where: { locationId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        roleTitle: true,
        availability: {
          where: { weekday },
          select: { startTime: true, endTime: true },
          orderBy: { startTime: 'asc' },
        },
      },
    });

    const appts = await tx.appointment.findMany({
      where: {
        locationId,
        status: { in: [...NON_CANCELLED_STATUSES] },
        startsAt: { gte: day, lt: dayEnd },
      },
      select: { staffId: true, startsAt: true, endsAt: true },
    });

    return staff.map((s) => {
      const availableMinutes = s.availability.reduce((sum, w) => {
        const startMin = w.startTime.getUTCHours() * 60 + w.startTime.getUTCMinutes();
        const endMin = w.endTime.getUTCHours() * 60 + w.endTime.getUTCMinutes();
        return sum + Math.max(0, endMin - startMin);
      }, 0);

      const mine = appts.filter((a) => a.staffId === s.id);
      const bookedMinutes = mine.reduce((sum, a) => sum + minutesBetween(a.startsAt, a.endsAt), 0);

      const first = s.availability[0];
      const last = s.availability[s.availability.length - 1];
      const fmt = (d: Date) =>
        `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;

      return {
        staffId: s.id,
        staffName: s.name,
        roleTitle: s.roleTitle,
        window: first ? { start: fmt(first.startTime), end: fmt(last!.endTime) } : null,
        availableMinutes,
        bookedMinutes,
        appointmentCount: mine.length,
      };
    });
  });
}
