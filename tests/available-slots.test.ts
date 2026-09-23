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
   * Staff whose windows are stored as 05:00–14:00 LOCAL.
   *
   * These digits used to be read as UTC and shifted by the location offset on
   * every read. Availability is stored in the location's local wall clock now,
   * so the digits ARE the local window and no offset is applied to them. What
   * the timezone still decides is which local DAY a date maps to and how a
   * booked appointment's UTC instant lands in local minutes — which is what the
   * timezone test below now measures instead.
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
              timeBasis: 'local' as const,
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
          // 05:00–14:00 LOCAL, on every weekday.
          //
          // These digits used to be written as `utc_legacy` here, to exercise
          // the reader's conversion path. 20260923000001 forbids writing a
          // legacy row at all — the CHECK permits only 'local' — so the
          // conversion path is now asserted directly against
          // availabilityRangeMinutes/availabilityHHMM, which is where it lives.
          // A fixture cannot prove a reader by writing data the product will
          // never contain again.
          availability: {
            create: [0, 1, 2, 3, 4, 5, 6].map((wd) => ({
              weekday: wd,
              startTime: timeVal(5),
              endTime: timeVal(14),
              timeBasis: 'local' as const,
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
  it('a stored local window means the same hours in either location', async () => {
    // The fixture is local now (legacy rows can no longer be written), so the
    // stored digits ARE the local hours in either location — no offset applied.
    //
    // Before the basis existed the two halves disagreed silently: the write
    // path never applied the offset and the picker did, so they differed by
    // exactly the offset and neither side reported anything.
    const utcSlots = await withoutRls((tx) =>
      getAvailableSlots(tx, staffTbilisi, dateStr(9), 30, 'UTC'),
    );
    const tbilisiSlots = await withoutRls((tx) =>
      getAvailableSlots(tx, staffTbilisi, dateStr(9), 30, 'Asia/Tbilisi'),
    );

    expect(utcSlots).toContain('05:00');
    expect(utcSlots).toContain('13:30');
    expect(utcSlots).not.toContain('14:00'); // 14:00+30 > window end

    // +4h: the same stored digits mean 09:00-18:00 on a Tbilisi wall clock.
    expect(tbilisiSlots).toContain('05:00');
    expect(tbilisiSlots).toContain('13:30');
    expect(tbilisiSlots).not.toContain('14:00');

    // Identical: a local window means the same wall clock everywhere.
    expect(tbilisiSlots).toEqual(utcSlots);
  });

  it('THE REAL READ PATH converts a legacy row — getAvailableSlots, not a helper', async () => {
    // Dual-read must stay proven against the code that actually runs, and the
    // production database now REFUSES to store a legacy row (20260923000001).
    // Loosening that constraint to make a fixture insertable would be exactly
    // backwards — the constraint is the point.
    //
    // So the legacy row exists only inside a transaction that is rolled back:
    // the CHECK is dropped, the row inserted, getAvailableSlots() called on the
    // SAME tx, and then the whole thing thrown away. The production constraint
    // is untouched; nothing outside this transaction ever sees either.
    //
    // This is what a helper-level test cannot prove: that the reader reaches
    // the row, selects time_basis, and applies the conversion end to end.
    const staff = await withoutRls((tx) =>
      tx.staff.create({
        data: {
          organizationId: orgId,
          locationId,
          name: 'Legacy read path',
          roleTitle: 'Provider',
          availabilityConfiguredAt: new Date(),
        },
        select: { id: true },
      }),
    );

    const weekday = new Date(`${dateStr(9)}T12:00:00Z`).getUTCDay();
    const ROLLBACK = 'intentional rollback — the legacy row must not survive';

    let legacySlots: string[] = [];
    await expect(
      withoutRls(async (tx) => {
        // Inside this transaction only.
        await tx.$executeRawUnsafe(
          `ALTER TABLE staff_availability DROP CONSTRAINT staff_availability_time_basis_check`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO staff_availability (staff_id, weekday, start_time, end_time, time_basis)
             VALUES ($1::uuid, $2::smallint, TIME '05:00', TIME '13:00', 'utc_legacy')`,
          staff.id,
          weekday,
        );

        // THE PRODUCTION READER, on the same transaction.
        legacySlots = await getAvailableSlots(tx, staff.id, dateStr(9), 30, 'Asia/Tbilisi');

        throw new Error(ROLLBACK);
      }),
    ).rejects.toThrow(ROLLBACK);

    // 05:00-13:00 UTC is 09:00-17:00 in Tbilisi, so the reader must offer
    // 09:00 and not 05:00. A reader that ignored time_basis would do the
    // opposite, and that difference is the whole compatibility contract.
    expect(legacySlots).toContain('09:00');
    expect(legacySlots).toContain('16:30');
    expect(legacySlots).not.toContain('05:00');

    // The rollback really happened: no row, and the constraint is back.
    const survivors = await withoutRls((tx) =>
      tx.staffAvailability.count({ where: { staffId: staff.id } }),
    );
    expect(survivors, 'the legacy row must not have survived the rollback').toBe(0);
    await expect(
      withoutRls((tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO staff_availability (staff_id, weekday, start_time, end_time, time_basis)
             VALUES ($1::uuid, 1, TIME '05:00', TIME '13:00', 'utc_legacy')`,
          staff.id,
        ),
      ),
      'the production constraint must still refuse a legacy write',
    ).rejects.toThrow();

    await withoutRls((tx) => tx.staff.delete({ where: { id: staff.id } }));
  });

  it('THE REAL WRITE-TIME ENFORCER also honours a legacy row', async () => {
    // assertWithinAvailability() is the other production reader — the one that
    // decides whether a booking is allowed. Picker and enforcer must agree on
    // both bases, or they disagree by exactly the location offset, which is the
    // original defect this whole rollout exists to remove.
    const { assertWithinAvailability } = await import('@/lib/appointments');

    const staff = await withoutRls((tx) =>
      tx.staff.create({
        data: {
          organizationId: orgId,
          locationId,
          name: 'Legacy enforcer path',
          roleTitle: 'Provider',
          availabilityConfiguredAt: new Date(),
        },
        select: { id: true },
      }),
    );
    const weekday = new Date(`${dateStr(9)}T12:00:00Z`).getUTCDay();
    const ROLLBACK = 'intentional rollback';

    // 10:00 local Tbilisi = 06:00Z. Inside a legacy 05:00-13:00Z window, which
    // means 09:00-17:00 local.
    const inside = new Date(`${dateStr(9)}T06:00:00Z`);
    // 08:00 local = 04:00Z, before the window opens.
    const before = new Date(`${dateStr(9)}T04:00:00Z`);

    let insideOk = false;
    let beforeRejected = false;
    await expect(
      withoutRls(async (tx) => {
        await tx.$executeRawUnsafe(
          `ALTER TABLE staff_availability DROP CONSTRAINT staff_availability_time_basis_check`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO staff_availability (staff_id, weekday, start_time, end_time, time_basis)
             VALUES ($1::uuid, $2::smallint, TIME '05:00', TIME '13:00', 'utc_legacy')`,
          staff.id,
          weekday,
        );

        await assertWithinAvailability(
          tx,
          staff.id,
          inside,
          new Date(inside.getTime() + 30 * 60_000),
        );
        insideOk = true;

        await assertWithinAvailability(
          tx,
          staff.id,
          before,
          new Date(before.getTime() + 30 * 60_000),
        ).catch(() => {
          beforeRejected = true;
        });

        throw new Error(ROLLBACK);
      }),
    ).rejects.toThrow(ROLLBACK);

    expect(insideOk, '10:00 local is inside a legacy 09:00-17:00 window').toBe(true);
    expect(beforeRejected, '08:00 local is outside it').toBe(true);

    await withoutRls((tx) => tx.staff.delete({ where: { id: staff.id } }));
  });

  it('the READER still converts a legacy row, and takes a local row as stored', async () => {
    // Dual-read must survive certification: rows written before
    // 20260923000001, and anything restored from an older backup, still hold
    // UTC digits with a legacy marker and must read out as the right local
    // hours. The database now refuses to WRITE such a row, so this is asserted
    // against the reader directly rather than by creating one — which is the
    // honest place for it, since the reader is what would regress.
    const { availabilityRangeMinutes } = await import('@/lib/availability-basis');

    const legacy = availabilityRangeMinutes(
      {
        startTime: new Date('1970-01-01T05:00:00Z'),
        endTime: new Date('1970-01-01T13:00:00Z'),
        timeBasis: 'utc_legacy',
      },
      'Asia/Tbilisi',
    );
    expect(legacy.startMin).toBe(9 * 60); // 05:00Z -> 09:00 local
    expect(legacy.endMin).toBe(17 * 60); // 13:00Z -> 17:00 local

    const local = availabilityRangeMinutes(
      {
        startTime: new Date('1970-01-01T05:00:00Z'),
        endTime: new Date('1970-01-01T13:00:00Z'),
        timeBasis: 'local',
      },
      'Asia/Tbilisi',
    );
    expect(local.startMin).toBe(5 * 60); // same digits, taken as written
    expect(local.endMin).toBe(13 * 60);

    // The two must NOT agree. If they ever collapse to one answer, the
    // migration/deploy overlap becomes a four-hour error.
    expect(legacy.startMin).not.toBe(local.startMin);
  });

  it('EXCLUDES the appointment being rescheduled from its own occupancy', async () => {
    // Without this the slot a booking already occupies is reported as taken —
    // by itself — so the one time a user is most likely to keep is the one time
    // the reschedule picker hides.
    const appt = await withoutRls((tx) =>
      tx.appointment.create({
        data: {
          organizationId: orgId,
          locationId,
          customerId,
          staffId: staffTbilisi,
          serviceName: 'Self exclusion',
          price: 0,
          startsAt: ts(9, 6),
          endsAt: ts(9, 6, 30),
          status: 'confirmed',
        },
        select: { id: true },
      }),
    );
    createdAppointments.push(appt.id);

    const without = await withoutRls((tx) =>
      getAvailableSlots(tx, staffTbilisi, dateStr(9), 30, 'UTC'),
    );
    expect(without, 'its own slot is blocked by itself').not.toContain('06:00');

    const excluding = await withoutRls((tx) =>
      getAvailableSlots(tx, staffTbilisi, dateStr(9), 30, 'UTC', appt.id),
    );
    expect(excluding, 'excluded, so the slot is offered again').toContain('06:00');

    // The complement: excluding one appointment must not unblock a DIFFERENT
    // booking's slot, or reschedule would happily double-book.
    const other = await withoutRls((tx) =>
      tx.appointment.create({
        data: {
          organizationId: orgId,
          locationId,
          customerId,
          staffId: staffTbilisi,
          serviceName: 'Someone else',
          price: 0,
          startsAt: ts(9, 7),
          endsAt: ts(9, 7, 30),
          status: 'confirmed',
        },
        select: { id: true },
      }),
    );
    createdAppointments.push(other.id);
    const stillBlocked = await withoutRls((tx) =>
      getAvailableSlots(tx, staffTbilisi, dateStr(9), 30, 'UTC', appt.id),
    );
    expect(stillBlocked).not.toContain('07:00');
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
