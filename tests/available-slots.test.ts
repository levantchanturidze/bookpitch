/**
 * Probes for getAvailableSlots and toAppointmentDto:
 *   - Long service (90 min) blocks all overlapping candidates, not just the starting cell
 *   - Availability window boundary: can't start if the full duration doesn't fit before endTime
 *   - Back-to-back appointments: adjacent is allowed (strict less-than exclusion)
 *   - Sub-30-minute service (20 min): step = min(duration, 30) = 20; grid shifts to match
 *   - Non-evenly-dividing service (45 min): step = min(45, 30) = 30; boundary and blocking correct
 *   - Timezone: slots are returned as local HH:MM; same staff with UTC vs Tbilisi tz returns
 *     different times for the same availability windows
 *   - toAppointmentDto: date/time fields use org timezone; day boundary converted correctly
 *
 * What getAvailableSlots does NOT account for (features not yet in the schema):
 *   - Blocked time (StaffBlockedTime): no model exists
 *   - Location working hours (LocationHours): no model exists; Location has timezone but no open/close
 *   - Rooms / resources: no model exists
 *   - Buffer time between appointments: no bufferMinutes on Service or Staff
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { getAvailableSlots, toAppointmentDto } = await import('@/lib/appointments');

// All test appointments land in a far-future month to avoid seed collisions.
const YEAR = 2028;
const MONTH = 5; // June (0-indexed)

/** UTC midnight for a day in the test horizon. */
function dayMs(d: number): number {
  return Date.UTC(YEAR, MONTH, d);
}
/** ISO string for a UTC datetime in the test horizon. */
function ts(d: number, h: number, m = 0): Date {
  return new Date(dayMs(d) + h * 3600_000 + m * 60_000);
}
/** YYYY-MM-DD for a day in the test horizon. */
function dateStr(d: number): string {
  return new Date(dayMs(d)).toISOString().slice(0, 10);
}
/** Prisma Time column value: UTC epoch date + time-of-day. */
function timeVal(h: number, m = 0): Date {
  return new Date(Date.UTC(1970, 0, 1, h, m));
}

describe('getAvailableSlots', () => {
  let orgId: string;
  let locationId: string;
  /** Staff with NO availability windows — triggers the 07:00–21:00 fallback. */
  let staffDefault: string;
  /** Staff with a 09:00–18:00 UTC window used for boundary tests. */
  let staffWindowed: string;
  /**
   * Staff with 05:00–14:00 UTC windows = 09:00–18:00 Asia/Tbilisi (UTC+4).
   * Used to verify timezone-aware slot computation.
   */
  let staffTbilisi: string;
  let customerId: string;

  const createdAppointments: string[] = [];

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({
        data: { name: `slots-test-${Date.now()}` },
      });
      const loc = await tx.location.create({
        data: { organizationId: org.id, type: 'clinic', name: 'Slots Clinic' },
      });
      const sDefault = await tx.staff.create({
        data: {
          organizationId: org.id,
          locationId: loc.id,
          name: 'Default Staff',
          roleTitle: 'GP',
          // No availability rows → 07:00–21:00 fallback applies.
        },
      });
      const sWindowed = await tx.staff.create({
        data: {
          organizationId: org.id,
          locationId: loc.id,
          name: 'Windowed Staff',
          roleTitle: 'Specialist',
          // Availability: Mon–Sun 09:00–18:00 UTC. All test days fall in this window.
          availability: {
            create: [0, 1, 2, 3, 4, 5, 6].map((wd) => ({
              weekday: wd,
              startTime: timeVal(9),
              endTime: timeVal(18),
            })),
          },
        },
      });
      const sTbilisi = await tx.staff.create({
        data: {
          organizationId: org.id,
          locationId: loc.id,
          name: 'Tbilisi Staff',
          roleTitle: 'Consultant',
          // 05:00–14:00 UTC = 09:00–18:00 Asia/Tbilisi. All weekdays.
          availability: {
            create: [0, 1, 2, 3, 4, 5, 6].map((wd) => ({
              weekday: wd,
              startTime: timeVal(5),
              endTime: timeVal(14),
            })),
          },
        },
      });
      const customer = await tx.customer.create({
        data: { organizationId: org.id, name: 'Slot Tester' },
      });
      return { org, loc, sDefault, sWindowed, sTbilisi, customer };
    });
    orgId = seed.org.id;
    locationId = seed.loc.id;
    staffDefault = seed.sDefault.id;
    staffWindowed = seed.sWindowed.id;
    staffTbilisi = seed.sTbilisi.id;
    customerId = seed.customer.id;
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      if (createdAppointments.length) {
        await tx.appointment.deleteMany({ where: { id: { in: createdAppointments } } });
      }
      await tx.customer.deleteMany({ where: { organizationId: orgId } });
      await tx.staffAvailability.deleteMany({ where: { staff: { organizationId: orgId } } });
      await tx.staff.deleteMany({ where: { organizationId: orgId } });
      await tx.location.delete({ where: { id: locationId } });
      await tx.organization.delete({ where: { id: orgId } });
    });
  });

  // ---------------------------------------------------------------------------
  // Helper: create an appointment directly bypassing RLS (we own the org).
  // ---------------------------------------------------------------------------
  async function plant(
    staffId: string,
    day: number,
    startH: number,
    endH: number,
    endM = 0,
    startM = 0,
  ) {
    const appt = await withoutRls((tx) =>
      tx.appointment.create({
        data: {
          organizationId: orgId,
          locationId,
          customerId,
          staffId,
          startsAt: ts(day, startH, startM),
          endsAt: ts(day, endH, endM),
          serviceName: 'Planted',
          price: 0,
          status: 'confirmed',
        },
      }),
    );
    createdAppointments.push(appt.id);
    return appt;
  }

  // ---------------------------------------------------------------------------
  it('no appointments → full default window 07:00–21:00 at 30-min steps', async () => {
    const slots = await withoutRls((tx) => getAvailableSlots(tx, staffDefault, dateStr(1), 30));
    // 07:00 to 20:30 inclusive: (21*60-7*60)/30 = 28 slots
    expect(slots).toContain('07:00');
    expect(slots).toContain('20:30');
    expect(slots).not.toContain('21:00'); // 21:00+30 > 21:00
    expect(slots.length).toBe(28);
  });

  // ---------------------------------------------------------------------------
  it('90-min service: booked slot blocks all overlapping candidates', async () => {
    // Book 10:00–11:30. For a new 90-min service the following starts overlap:
    //   09:00 (ends 10:30) ↔ 09:00 < 11:30 && 10:30 > 10:00 → taken
    //   09:30 (ends 11:00) ↔ 09:30 < 11:30 && 11:00 > 10:00 → taken
    //   10:00 (ends 11:30) → taken (exact overlap)
    //   10:30 (ends 12:00) ↔ 10:30 < 11:30 && 12:00 > 10:00 → taken
    //   11:00 (ends 12:30) ↔ 11:00 < 11:30 && 12:30 > 10:00 → taken
    //   11:30 (ends 13:00) ↔ 11:30 < 11:30 → FALSE → available ✓
    await plant(staffDefault, 2, 10, 11, 30);
    const slots = await withoutRls((tx) => getAvailableSlots(tx, staffDefault, dateStr(2), 90));
    expect(slots).not.toContain('09:00');
    expect(slots).not.toContain('09:30');
    expect(slots).not.toContain('10:00');
    expect(slots).not.toContain('10:30');
    expect(slots).not.toContain('11:00');
    expect(slots).toContain('11:30'); // first slot after 10:00–11:30
  });

  // ---------------------------------------------------------------------------
  it('availability window boundary: 60-min service in a 09:00–18:00 window', async () => {
    // 17:00+60=18:00 fits; 17:30+60=18:30 does not → last slot is 17:00.
    const slots = await withoutRls((tx) => getAvailableSlots(tx, staffWindowed, dateStr(3), 60));
    expect(slots).toContain('09:00');
    expect(slots).toContain('17:00');
    expect(slots).not.toContain('17:30'); // 17:30+60=18:30 > 18:00
    expect(slots).not.toContain('18:00');
  });

  // ---------------------------------------------------------------------------
  it('90-min service in a 09:00–18:00 window: last slot is 16:30', async () => {
    // 16:30+90=18:00 fits; 17:00+90=18:30 does not.
    const slots = await withoutRls((tx) => getAvailableSlots(tx, staffWindowed, dateStr(4), 90));
    expect(slots).toContain('16:30');
    expect(slots).not.toContain('17:00');
  });

  // ---------------------------------------------------------------------------
  it('back-to-back (adjacent) bookings: adjacent slot is available', async () => {
    // 10:00–10:30 and 10:30–11:00 both booked; 11:00 must be free.
    await plant(staffDefault, 5, 10, 10, 30);
    await plant(staffDefault, 5, 10, 11, 0, 30);
    const slots = await withoutRls((tx) => getAvailableSlots(tx, staffDefault, dateStr(5), 30));
    expect(slots).not.toContain('10:00');
    expect(slots).not.toContain('10:30');
    expect(slots).toContain('11:00');
  });

  // ---------------------------------------------------------------------------
  it('sub-30-minute service (20 min): step = min(20, 30) = 20; grid shifts', async () => {
    // step = min(20, 30) = 20. Offered: 07:00, 07:20, 07:40, 08:00, ..., 09:00, 09:20, ...
    // Book 09:00–09:20. The slot at 09:00 is blocked.
    // 09:20 starts exactly at booking end: 09:20 < 09:20 → FALSE → NOT blocked → offered.
    // 09:30 is not on the 20-min grid (07:00 + n*20 never lands on :30).
    await plant(staffDefault, 6, 9, 9, 20);
    const slots = await withoutRls((tx) => getAvailableSlots(tx, staffDefault, dateStr(6), 20));
    expect(slots).not.toContain('09:00'); // overlaps 09:00–09:20
    expect(slots).toContain('09:20'); // step=20; strict < means not blocked
    expect(slots).toContain('09:40'); // also not blocked
    // Complement: 07:30 is on a 30-min grid but NOT on the 20-min grid.
    expect(slots).toContain('07:20');
    expect(slots).not.toContain('07:30');
  });

  // ---------------------------------------------------------------------------
  it('45-min service: 09:00 and 09:30 offered in 09:00–10:15; booking 09:00 blocks 09:30', async () => {
    // step = min(45, 30) = 30 (unchanged from pre-Phase3 for services >= 30 min).
    // Book 45 min at 09:00 (ends 09:45). Next candidate 09:30 overlaps 09:45:
    //   09:30 < 09:45 && (09:30+45=10:15) > 09:00 → taken.
    // Candidate 10:00: 10:00 < 09:45? No → available.
    await plant(staffDefault, 7, 9, 9, 45);
    const slots = await withoutRls((tx) => getAvailableSlots(tx, staffDefault, dateStr(7), 45));
    expect(slots).not.toContain('09:00');
    expect(slots).not.toContain('09:30'); // overlaps 09:00–09:45
    expect(slots).toContain('10:00'); // 10:00 starts after 09:45 end
  });

  // ---------------------------------------------------------------------------
  it('cancelled appointment does not block the slot', async () => {
    const appt = await withoutRls((tx) =>
      tx.appointment.create({
        data: {
          organizationId: orgId,
          locationId,
          customerId,
          staffId: staffDefault,
          startsAt: ts(8, 14),
          endsAt: ts(8, 14, 30),
          serviceName: 'Cancelled',
          price: 0,
          status: 'cancelled',
        },
      }),
    );
    createdAppointments.push(appt.id);
    const slots = await withoutRls((tx) => getAvailableSlots(tx, staffDefault, dateStr(8), 30));
    expect(slots).toContain('14:00');
  });

  // ---------------------------------------------------------------------------
  it('timezone: same staff returns local HH:MM; Tbilisi shifts by +4h vs UTC', async () => {
    // staffTbilisi has windows stored as 05:00–14:00 UTC = 09:00–18:00 Tbilisi.
    // With timezone='UTC': slots are in UTC HH:MM → 05:00 … 13:30.
    // With timezone='Asia/Tbilisi': slots are in local HH:MM → 09:00 … 17:30.
    const utcSlots = await withoutRls((tx) =>
      getAvailableSlots(tx, staffTbilisi, dateStr(9), 30, 'UTC'),
    );
    const tbilisiSlots = await withoutRls((tx) =>
      getAvailableSlots(tx, staffTbilisi, dateStr(9), 30, 'Asia/Tbilisi'),
    );

    // UTC view: first slot 05:00, last 13:30 (window 05:00–14:00 UTC; 14:00+30 > 14:00)
    expect(utcSlots).toContain('05:00');
    expect(utcSlots).toContain('13:30');
    expect(utcSlots).not.toContain('14:00'); // 14:00+30=14:30 > window end

    // Tbilisi view: window is 09:00–18:00 local; first slot 09:00, last 17:30
    expect(tbilisiSlots).toContain('09:00');
    expect(tbilisiSlots).toContain('17:30');
    expect(tbilisiSlots).not.toContain('05:00'); // 05:00 local = 01:00 UTC, outside window
    expect(tbilisiSlots).not.toContain('18:00'); // 18:00+30=18:30 > local window end

    // Same number of slots — same window width, just labelled differently.
    expect(tbilisiSlots.length).toBe(utcSlots.length);
    // First slot in Tbilisi is exactly 4 hours ahead of first UTC slot.
    expect(utcSlots[0]).toBe('05:00');
    expect(tbilisiSlots[0]).toBe('09:00');
  });
});

// ---------------------------------------------------------------------------
describe('toAppointmentDto timezone', () => {
  it('converts date and time to org timezone, not UTC', () => {
    // 09:00 UTC = 13:00 Asia/Tbilisi (UTC+4). Both on the same calendar day.
    const row = makeRow(new Date('2028-06-05T09:00:00Z'), new Date('2028-06-05T09:30:00Z'));
    const utcDto = toAppointmentDto(row, 'UTC');
    const tbilisiDto = toAppointmentDto(row, 'Asia/Tbilisi');

    expect(utcDto.date).toBe('2028-06-05');
    expect(utcDto.time).toBe('09:00');

    expect(tbilisiDto.date).toBe('2028-06-05');
    expect(tbilisiDto.time).toBe('13:00');
  });

  it('crosses the calendar day boundary when UTC time pushes local to the next day', () => {
    // 21:30 UTC = 01:30 the next day in Asia/Tbilisi (UTC+4).
    const row = makeRow(new Date('2028-06-05T21:30:00Z'), new Date('2028-06-05T22:00:00Z'));
    const utcDto = toAppointmentDto(row, 'UTC');
    const tbilisiDto = toAppointmentDto(row, 'Asia/Tbilisi');

    expect(utcDto.date).toBe('2028-06-05');
    expect(utcDto.time).toBe('21:30');

    expect(tbilisiDto.date).toBe('2028-06-06'); // pushed to next local day
    expect(tbilisiDto.time).toBe('01:30');
  });
});

// ---------------------------------------------------------------------------
// Builds a minimal appointment row for toAppointmentDto without hitting the DB.
function makeRow(startsAt: Date, endsAt: Date) {
  return {
    id: 'test-id',
    organizationId: 'org-id',
    locationId: 'loc-id',
    customerId: 'cust-id',
    staffId: 'staff-id',
    serviceId: null,
    startsAt,
    endsAt,
    serviceName: 'Test Service',
    price: 100 as unknown as import('@prisma/client').Prisma.Decimal,
    status: 'confirmed' as const,
    paymentStatus: 'unpaid' as const,
    notes: null,
    icd10Code: null,
    icd10Description: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: 'c', name: 'Customer', phone: null, avatarUrl: null },
    staff: { id: 's', name: 'Staff', roleTitle: 'GP', calendarColor: null },
  };
}
