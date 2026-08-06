import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { computeMetrics, dailyRoster } = await import('@/lib/analytics');

// -----------------------------------------------------------------------------
// Build a dedicated org fixture with hand-computable numbers. We anchor
// everything to a fixed refDate and place appointments/staff we control, so
// the tests are stable regardless of what the main seed did.
// -----------------------------------------------------------------------------

// Refdate: Wed, 2027-05-05 12:00 UTC — far from any seeded data, real weekday.
const REF_DATE = new Date(Date.UTC(2027, 4, 5, 12, 0, 0));
const REF_DAY = Date.UTC(2027, 4, 5); // start of day
const PREV_WEEK_DAY = Date.UTC(2027, 3, 28); // 7 days earlier (Wed)
const REF_WEEKDAY = 3; // Wednesday

function ts(dayMs: number, hour: number, min = 0): Date {
  return new Date(dayMs + hour * 3600_000 + min * 60_000);
}
function time(hour: number, min = 0): Date {
  return new Date(Date.UTC(1970, 0, 1, hour, min));
}

describe('analytics.computeMetrics + dailyRoster', () => {
  let orgId: string;
  let userId: string;
  let locationId: string;
  let staffAlpha: string;
  let staffBeta: string;
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({
        data: { name: 'Analytics Fixture Org', reminderLeadHours: 24 },
      });
      const location = await tx.location.create({
        data: { organizationId: org.id, type: 'clinic', name: 'Analytics Clinic' },
      });
      const service = await tx.service.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'Fixture service',
          price: 100,
          durationMinutes: 30,
        },
      });
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: 'analytics-owner@bookpitch.dev',
          email: 'analytics-owner@bookpitch.dev',
        },
      });

      // Alpha works 09-13 Wed (240 available minutes). Beta works 09-11 Wed
      // (120 available minutes). Total available today: 360 min.
      const alpha = await tx.staff.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'Alpha Staff',
          roleTitle: 'Fixture Practitioner A',
          availability: {
            create: [{ weekday: REF_WEEKDAY, startTime: time(9), endTime: time(13) }],
          },
        },
      });
      const beta = await tx.staff.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          name: 'Beta Staff',
          roleTitle: 'Fixture Practitioner B',
          availability: {
            create: [{ weekday: REF_WEEKDAY, startTime: time(9), endTime: time(11) }],
          },
        },
      });

      const customer = await tx.customer.create({
        data: { organizationId: org.id, name: 'Fixture Patient' },
      });

      // --- Today's appointments ---
      // Alpha: confirmed 09:00–09:30 (30m) PAID 200. → booked 30, revenue 200.
      // Alpha: pending   10:00–10:30 (30m) unpaid. → NOT booked for occupancy,
      //                                                but counts in bookings.
      // Beta:  completed 09:00–10:00 (60m) PAID 100. → booked 60, revenue 100.
      // Beta:  cancelled 10:30–11:00 → ignored everywhere.
      const todayAppts = await Promise.all([
        tx.appointment.create({
          data: {
            organizationId: org.id,
            locationId: location.id,
            customerId: customer.id,
            staffId: alpha.id,
            serviceId: service.id,
            startsAt: ts(REF_DAY, 9),
            endsAt: ts(REF_DAY, 9, 30),
            serviceName: service.name,
            price: 200,
            status: 'confirmed',
            paymentStatus: 'paid',
          },
        }),
        tx.appointment.create({
          data: {
            organizationId: org.id,
            locationId: location.id,
            customerId: customer.id,
            staffId: alpha.id,
            serviceId: service.id,
            startsAt: ts(REF_DAY, 10),
            endsAt: ts(REF_DAY, 10, 30),
            serviceName: service.name,
            price: 100,
            status: 'pending',
            paymentStatus: 'unpaid',
          },
        }),
        tx.appointment.create({
          data: {
            organizationId: org.id,
            locationId: location.id,
            customerId: customer.id,
            staffId: beta.id,
            serviceId: service.id,
            startsAt: ts(REF_DAY, 9),
            endsAt: ts(REF_DAY, 10),
            serviceName: service.name,
            price: 100,
            status: 'completed',
            paymentStatus: 'paid',
          },
        }),
        tx.appointment.create({
          data: {
            organizationId: org.id,
            locationId: location.id,
            customerId: customer.id,
            staffId: beta.id,
            serviceId: service.id,
            startsAt: ts(REF_DAY, 10, 30),
            endsAt: ts(REF_DAY, 11),
            serviceName: service.name,
            price: 50,
            status: 'cancelled',
            paymentStatus: 'unpaid',
          },
        }),
      ]);

      // --- Same-weekday last week: one paid appointment at 60. Sets up the
      // revenue delta = (300 - 60) / 60 * 100 = 400%.
      const prevWeekAppt = await tx.appointment.create({
        data: {
          organizationId: org.id,
          locationId: location.id,
          customerId: customer.id,
          staffId: alpha.id,
          serviceId: service.id,
          startsAt: ts(PREV_WEEK_DAY, 9),
          endsAt: ts(PREV_WEEK_DAY, 9, 30),
          serviceName: service.name,
          price: 60,
          status: 'confirmed',
          paymentStatus: 'paid',
        },
      });

      // Cleanup order matters (FKs).
      cleanup.push(async () => {
        await withoutRls((tx) =>
          tx.appointment.deleteMany({
            where: { id: { in: [...todayAppts.map((a) => a.id), prevWeekAppt.id] } },
          }),
        );
        await withoutRls((tx) => tx.customer.delete({ where: { id: customer.id } }));
        await withoutRls((tx) =>
          tx.staffAvailability.deleteMany({ where: { staffId: { in: [alpha.id, beta.id] } } }),
        );
        await withoutRls((tx) =>
          tx.staff.deleteMany({ where: { id: { in: [alpha.id, beta.id] } } }),
        );
        await withoutRls((tx) => tx.service.delete({ where: { id: service.id } }));
        await withoutRls((tx) => tx.location.delete({ where: { id: location.id } }));
        await withoutRls((tx) => tx.appUser.delete({ where: { id: user.id } }));
        await withoutRls((tx) => tx.organization.delete({ where: { id: org.id } }));
      });

      return {
        orgId: org.id,
        userId: user.id,
        locationId: location.id,
        alphaId: alpha.id,
        betaId: beta.id,
      };
    });
    orgId = seed.orgId;
    userId = seed.userId;
    locationId = seed.locationId;
    staffAlpha = seed.alphaId;
    staffBeta = seed.betaId;
  });

  afterAll(async () => {
    for (const step of cleanup.reverse()) {
      await step().catch(() => null);
    }
  });

  function session() {
    return {
      organizationId: orgId,
      userId,
      email: 'analytics-owner@bookpitch.dev',
      role: 'owner' as const,
    };
  }

  it('daily revenue = sum of paid appointments today (300 GEL)', async () => {
    const m = await computeMetrics(session(), locationId, REF_DATE);
    expect(m.revenue.current).toBe(300);
    expect(m.revenue.previous).toBe(60);
    expect(m.revenue.deltaPct).toBeCloseTo(400, 5);
  });

  it('daily bookings = 3 (confirmed + pending + completed, cancelled ignored)', async () => {
    const m = await computeMetrics(session(), locationId, REF_DATE);
    expect(m.bookings.current).toBe(3);
    expect(m.bookings.previous).toBe(1);
  });

  it('occupancy = 90 booked / 360 available = 25%', async () => {
    const m = await computeMetrics(session(), locationId, REF_DATE);
    expect(m.occupancy.bookedMinutes).toBe(90);
    expect(m.occupancy.availableMinutes).toBe(360);
    expect(m.occupancy.percent).toBeCloseTo(25, 5);
  });

  it('average ticket (30d, paid only) = (200 + 100 + 60) / 3 = 120', async () => {
    const m = await computeMetrics(session(), locationId, REF_DATE);
    expect(m.averageTicket.sampleSize).toBe(3);
    expect(m.averageTicket.amount).toBeCloseTo(120, 5);
  });

  it('trend has 7 entries with today = 300 revenue / 3 bookings', async () => {
    const m = await computeMetrics(session(), locationId, REF_DATE);
    expect(m.trend.length).toBe(7);
    const today = m.trend.find((p) => p.date === '2027-05-05');
    expect(today?.revenue).toBe(300);
    expect(today?.bookings).toBe(3);
    // Same-weekday last week is +/-7 out of the 7-day window (window is
    // today - 6 days .. today), so 2027-04-28 is NOT in the trend. Good.
    expect(m.trend.find((p) => p.date === '2027-04-28')).toBeUndefined();
  });

  it('bookings per staff: Alpha=2, Beta=1 (cancelled ignored)', async () => {
    const m = await computeMetrics(session(), locationId, REF_DATE);
    const alpha = m.bookingsPerStaff.find((s) => s.staffId === staffAlpha);
    const beta = m.bookingsPerStaff.find((s) => s.staffId === staffBeta);
    expect(alpha?.bookings).toBe(2);
    expect(beta?.bookings).toBe(1);
  });

  it('daily roster: Alpha 09-13 (booked 60/240), Beta 09-11 (booked 60/120)', async () => {
    const roster = await dailyRoster(session(), locationId, REF_DATE);
    const alpha = roster.find((r) => r.staffId === staffAlpha);
    const beta = roster.find((r) => r.staffId === staffBeta);
    expect(alpha?.window).toEqual({ start: '09:00', end: '13:00' });
    expect(alpha?.availableMinutes).toBe(240);
    expect(alpha?.bookedMinutes).toBe(60); // only the confirmed 30 + pending 30
    expect(alpha?.appointmentCount).toBe(2);

    expect(beta?.window).toEqual({ start: '09:00', end: '11:00' });
    expect(beta?.availableMinutes).toBe(120);
    expect(beta?.bookedMinutes).toBe(60);
    expect(beta?.appointmentCount).toBe(1); // cancelled excluded
  });
});
