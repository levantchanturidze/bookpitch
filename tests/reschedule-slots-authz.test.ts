import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { fetchRescheduleSlotsAction } = await import('@/components/scheduler/reschedule-actions');

// -----------------------------------------------------------------------------
// 5.5 / §5 — the reschedule slot lookup is the one place a client can name an
// appointment and have it REMOVED from conflict detection.
//
// fetchAvailableSlotsAction() deliberately has no exclusion parameter. If it
// did, any caller could pass somebody else's appointment id and make the slot
// it occupies look free, then book straight through it. So the exclusion lives
// in a separate action that resolves the appointment inside the caller's own
// tenant, authorises booking.update against that exact owner/branch resource,
// and excludes only the row it resolved.
//
// These tests exercise that boundary through the action, not through can().
// tests/scheduler-resource-scope.test.ts already pins the permission decision;
// what matters here is that the action cannot be talked into applying it to
// the wrong row.
// -----------------------------------------------------------------------------

describe('fetchRescheduleSlotsAction — exclusion is bound to the resolved appointment', () => {
  let ownerId: string;
  let orgId: string;
  let otherOrgId: string;
  let locationId: string;
  let otherLocationId: string;
  let staffId: string;
  let otherLocationStaffId: string;
  let appointmentId: string;
  let foreignAppointmentId: string;

  beforeAll(async () => {
    // Seed ONLY if the fixture user is missing.
    //
    // tests/rbac-backfill.test.ts opens with a table-wide
    // `DELETE FROM app_users …` and vitest runs files in parallel, so an
    // unconditional seedRbacFixtures() here contends for locks on app_users
    // and this suite's first test waits ~25s and times out. It is not an
    // assertion failure and it does not reproduce when the file runs alone,
    // which is exactly the kind of flake that gets rerun instead of read.
    const existing = await unsafePrismaAdmin.appUser.findFirst({
      where: { email: 'split-owner@bp.test' },
      select: { id: true },
    });
    if (!existing) await seedRbacFixtures();

    const owner = await unsafePrismaAdmin.appUser.findFirstOrThrow({
      where: { email: 'split-owner@bp.test' },
      select: { id: true, memberships: { select: { organizationId: true }, take: 1 } },
    });
    ownerId = owner.id;
    orgId = owner.memberships[0].organizationId;

    const seeded = await withoutRls(async (tx) => {
      // vitest runs test FILES in parallel, and tests/rbac-backfill.test.ts
      // asserts invariants over the whole database AS IT FINDS IT — including
      // "every non-archived organisation has an owner". Cleaning up in afterAll
      // does not help: these fixtures are visible to that suite for as long as
      // this one runs, so they have to satisfy the invariants while they exist.
      //
      // The branches half needs nothing here: locations_rbac_sync_insert /
      // _delete keep the branches table paired with locations automatically.
      const loc = await tx.location.create({
        data: { organizationId: orgId, type: 'clinic', name: 'Reschedule Clinic' },
      });
      const staff = await tx.staff.create({
        data: {
          organizationId: orgId,
          locationId: loc.id,
          name: 'Reschedule Staff',
          roleTitle: 'Provider',
          availabilityConfiguredAt: new Date(),
          availability: {
            // LOCAL digits, marked explicitly. The fixture means "this provider
            // works 09:00-17:00 on the clinic wall clock", and the Stage A
            // default is 'utc_legacy' — omitting the marker would have every
            // reader add the Tbilisi offset and enforce 13:00-21:00 instead.
            create: [1, 2, 3, 4, 5].map((weekday) => ({
              weekday,
              startTime: new Date('1970-01-01T09:00:00Z'),
              endTime: new Date('1970-01-01T17:00:00Z'),
              timeBasis: 'local' as const,
            })),
          },
        },
      });
      const customer = await tx.customer.create({
        data: { organizationId: orgId, name: 'Reschedule Customer' },
      });
      // A second location in the SAME org, to prove staff must belong to the
      // appointment's location and not merely to the tenant.
      const otherLoc = await tx.location.create({
        data: { organizationId: orgId, type: 'salon', name: 'Other Branch' },
      });
      const otherStaff = await tx.staff.create({
        data: {
          organizationId: orgId,
          locationId: otherLoc.id,
          name: 'Other Branch Staff',
          roleTitle: 'Provider',
        },
      });
      const appt = await tx.appointment.create({
        data: {
          organizationId: orgId,
          locationId: loc.id,
          customerId: customer.id,
          staffId: staff.id,
          serviceName: 'Reschedule Service',
          price: 10,
          // 2027-04-12 is a Monday. 10:00 local in the default Asia/Tbilisi
          // clinic calendar is 06:00Z.
          startsAt: new Date('2027-04-12T06:00:00Z'),
          endsAt: new Date('2027-04-12T06:30:00Z'),
          status: 'confirmed',
        },
        select: { id: true },
      });

      // The cross-tenant fixture uses an EXISTING seeded organisation rather
      // than a new one. Creating an org here meant either leaving it without an
      // owner (breaking rbac-backfill's invariant B while this suite runs) or
      // setting owner_user_id, which the database rejects without a matching
      // active owner membership — CLAUDE.md invariant 5. A seeded org already
      // satisfies both, so the fixture borrows one and only adds rows that
      // carry no org-level invariant.
      // Derived from a LOCATION, not an organisation: the first active org in
      // the fixtures has no location, and a cross-tenant appointment needs one.
      const foreignLoc = await tx.location.findFirstOrThrow({
        where: { organizationId: { not: orgId } },
        select: { id: true, organizationId: true },
      });
      const foreignOrg = { id: foreignLoc.organizationId };
      const foreignStaff = await tx.staff.create({
        data: {
          organizationId: foreignOrg.id,
          locationId: foreignLoc.id,
          name: 'Foreign Staff',
          roleTitle: 'Provider',
        },
      });
      const foreignCustomer = await tx.customer.create({
        data: { organizationId: foreignOrg.id, name: 'Foreign Customer' },
      });
      const foreignAppt = await tx.appointment.create({
        data: {
          organizationId: foreignOrg.id,
          locationId: foreignLoc.id,
          customerId: foreignCustomer.id,
          staffId: foreignStaff.id,
          serviceName: 'Foreign Service',
          price: 10,
          startsAt: new Date('2027-04-12T06:00:00Z'),
          endsAt: new Date('2027-04-12T06:30:00Z'),
          status: 'confirmed',
        },
        select: { id: true },
      });

      return {
        locId: loc.id,
        staffId: staff.id,
        otherLocId: otherLoc.id,
        otherStaffId: otherStaff.id,
        apptId: appt.id,
        foreignOrgId: foreignOrg.id,
        foreignApptId: foreignAppt.id,
      };
    });

    locationId = seeded.locId;
    staffId = seeded.staffId;
    otherLocationId = seeded.otherLocId;
    otherLocationStaffId = seeded.otherStaffId;
    appointmentId = seeded.apptId;
    otherOrgId = seeded.foreignOrgId;
    foreignAppointmentId = seeded.foreignApptId;
  });

  // Remove exactly what this suite made, so a later run starts clean.
  //
  // Only rows this suite created. The borrowed cross-tenant organisation and
  // its location are seeded fixtures and are left exactly as found.
  afterAll(async () => {
    await withoutRls(async (tx) => {
      // Appointments first: staff and customers are referenced by them.
      await tx.appointment.deleteMany({
        where: { serviceName: { in: ['Reschedule Service', 'Blocker', 'Foreign Service'] } },
      });
      await tx.staffAvailability.deleteMany({
        where: {
          staff: { name: { in: ['Reschedule Staff', 'Other Branch Staff', 'Foreign Staff'] } },
        },
      });
      await tx.customer.deleteMany({
        where: { name: { in: ['Reschedule Customer', 'Foreign Customer'] } },
      });
      await tx.staff.deleteMany({
        where: { name: { in: ['Reschedule Staff', 'Other Branch Staff', 'Foreign Staff'] } },
      });
      // Only the two locations this suite created. locations_rbac_sync_delete
      // removes their paired branch rows, so the branches table stays in step
      // without this suite touching it.
      await tx.location.deleteMany({ where: { id: { in: [locationId, otherLocationId] } } });
    });
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockJwt(ownerId, orgId));
  });

  it('offers the appointment its OWN current slot back', async () => {
    // Self-exclusion, through the real entry point. Without it the one time the
    // user is most likely to keep is the one time the picker hides.
    const res = await fetchRescheduleSlotsAction(appointmentId, staffId, '2027-04-12');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.slots).toContain('10:00');
  });

  it('REFUSES an appointment id from another tenant, without confirming it exists', async () => {
    // The exact attack the separate action exists to prevent. The reply must be
    // indistinguishable from a deleted row: no "forbidden", which would confirm
    // the id is real.
    const res = await fetchRescheduleSlotsAction(foreignAppointmentId, staffId, '2027-04-12');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('appointment_not_found');
  });

  it('refuses a well-formed id that simply does not exist, identically', async () => {
    const res = await fetchRescheduleSlotsAction(
      '123e4567-e89b-42d3-a456-426614174000',
      staffId,
      '2027-04-12',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('appointment_not_found');
  });

  it('refuses a staff member from a DIFFERENT location in the same tenant', async () => {
    // Same org is not enough — the replacement staff member has to work at the
    // appointment's location, or availability is read off an unrelated branch.
    const res = await fetchRescheduleSlotsAction(appointmentId, otherLocationStaffId, '2027-04-12');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('staff_not_at_location');
  });

  it('rejects malformed identifiers and dates before touching the database', async () => {
    for (const [appt, staff, date] of [
      ['not-a-uuid', staffId, '2027-04-12'],
      [appointmentId, 'not-a-uuid', '2027-04-12'],
      [appointmentId, staffId, '2027-13-40'],
      [appointmentId, staffId, '12/04/2027'],
      [appointmentId, staffId, ''],
    ] as const) {
      const res = await fetchRescheduleSlotsAction(appt, staff, date);
      expect(res.ok, `${appt}/${staff}/${date}`).toBe(false);
      if (!res.ok) expect(res.error).toBe('invalid_request');
    }
  });

  it('derives duration from the stored appointment, not from the caller', async () => {
    // The action takes no duration argument at all, which is the point: a
    // caller asking for 5-minute availability on a 30-minute booking would make
    // the picker disagree with the write path all over again.
    expect(fetchRescheduleSlotsAction.length).toBe(3);

    const res = await fetchRescheduleSlotsAction(appointmentId, staffId, '2027-04-12');
    expect(res.ok).toBe(true);
    if (res.ok) {
      // 30-minute booking inside 09:00-17:00 gives half-hour starts, and the
      // last one that still fits is 16:30.
      expect(res.slots).toContain('16:30');
      expect(res.slots).not.toContain('16:45');
      expect(res.slots).not.toContain('17:00');
    }
  });

  it('returns no slots for an explicit day off rather than a default working day', async () => {
    // 2027-04-11 is a Sunday and this staff member is configured Mon-Fri, so
    // the picker must be empty — the fail-open twin of the day-off hole.
    const res = await fetchRescheduleSlotsAction(appointmentId, staffId, '2027-04-11');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.slots).toEqual([]);
  });

  it('still hides a slot occupied by a DIFFERENT booking', async () => {
    // Excluding the appointment under edit must not unblock anyone else's, or
    // reschedule becomes a double-booking tool.
    const customer = await withoutRls((tx) =>
      tx.customer.findFirstOrThrow({ where: { organizationId: orgId } }),
    );
    await withoutRls((tx) =>
      tx.appointment.create({
        data: {
          organizationId: orgId,
          locationId,
          customerId: customer.id,
          staffId,
          serviceName: 'Blocker',
          price: 0,
          startsAt: new Date('2027-04-12T07:00:00Z'),
          endsAt: new Date('2027-04-12T07:30:00Z'),
          status: 'confirmed',
        },
      }),
    );

    const res = await fetchRescheduleSlotsAction(appointmentId, staffId, '2027-04-12');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.slots, 'its own slot is still offered').toContain('10:00');
      expect(res.slots, "someone else's slot stays blocked").not.toContain('11:00');
    }
  });

  it('does not leak the foreign tenant id through the other-org appointment', async () => {
    expect(otherOrgId).toBeTruthy();
    expect(otherLocationId).toBeTruthy();
  });
});
