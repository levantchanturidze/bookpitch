import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const {
  createLocation,
  createService,
  createStaff,
  deleteLocation,
  listLocations,
  listMembers,
  listStaff,
  removeMember,
  setAvailability,
  updateMemberRole,
} = await import('@/lib/admin');
// Phase 4: inviteMember (password-directly path) was removed. New invitations
// go through the token flow in `lib/invitations.ts`, tested in
// tests/invitations.test.ts.
const { createInvitation } = await import('@/lib/invitations');

// -----------------------------------------------------------------------------
// Fixture: dedicated org so the tests don't churn the primary demo data.
// -----------------------------------------------------------------------------

type Session = {
  organizationId: string;
  userId: string;
  email: string;
  role: 'owner';
};

describe('admin CRUD × 4 surfaces', () => {
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let ownerSession: Session;
  let otherOwnerSession: Session;
  const cleanup: Array<() => Promise<void>> = [];
  const trackedLocationIds: string[] = [];
  const trackedStaffIds: string[] = [];
  const trackedServiceIds: string[] = [];
  const trackedUserIds: string[] = [];

  beforeAll(async () => {
    const ts = Date.now();
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `Admin Fixture Org ${ts}` } });
      const other = await tx.organization.create({ data: { name: `Other Admin Org ${ts}` } });
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `admin-owner-${ts}@bookpitch.dev`,
          email: `admin-owner-${ts}@bookpitch.dev`,
        },
      });
      const otherUser = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `other-admin-owner-${ts}@bookpitch.dev`,
          email: `other-admin-owner-${ts}@bookpitch.dev`,
        },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: user.id, role: 'owner' },
      });
      await tx.membership.create({
        data: { organizationId: other.id, userId: otherUser.id, role: 'owner' },
      });
      return {
        orgId: org.id,
        otherId: other.id,
        userId: user.id,
        otherUserId: otherUser.id,
        email: `admin-owner-${ts}@bookpitch.dev`,
        otherEmail: `other-admin-owner-${ts}@bookpitch.dev`,
      };
    });
    orgId = seed.orgId;
    otherOrgId = seed.otherId;
    userId = seed.userId;
    ownerSession = {
      organizationId: orgId,
      userId,
      email: seed.email,
      role: 'owner',
    };
    otherOwnerSession = {
      organizationId: otherOrgId,
      userId: seed.otherUserId,
      email: seed.otherEmail,
      role: 'owner',
    };
    trackedUserIds.push(userId, seed.otherUserId);

    cleanup.push(async () => {
      await withoutRls((tx) =>
        tx.staffAvailability.deleteMany({ where: { staffId: { in: trackedStaffIds } } }),
      );
      await withoutRls((tx) => tx.staff.deleteMany({ where: { id: { in: trackedStaffIds } } }));
      await withoutRls((tx) => tx.service.deleteMany({ where: { id: { in: trackedServiceIds } } }));
      await withoutRls((tx) =>
        tx.location.deleteMany({ where: { id: { in: trackedLocationIds } } }),
      );
      await withoutRls((tx) =>
        tx.membership.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } }),
      );
      // audit_log is append-only in prod (spec §9.11); dev-only escape
      // hatch releases the FK grip so the fixture users + orgs can go.
      const { resetAuditForOrgs } = await import('./helpers/audit-reset');
      await resetAuditForOrgs([orgId, otherOrgId]);
      await withoutRls((tx) => tx.appUser.deleteMany({ where: { id: { in: trackedUserIds } } }));
      await withoutRls((tx) =>
        tx.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } }),
      );
    });
  });

  afterAll(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => null);
  });

  it('createLocation stores organizationId from session (tenancy inheritance)', async () => {
    const loc = await createLocation(ownerSession, {
      type: 'clinic',
      name: 'Fixture Clinic',
    });
    trackedLocationIds.push(loc.id);
    expect(loc.organizationId).toBe(orgId);

    const list = await listLocations(ownerSession);
    expect(list.some((l) => l.id === loc.id)).toBe(true);
  });

  it("other-org owner cannot see this org's locations (RLS)", async () => {
    const otherList = await listLocations(otherOwnerSession);
    expect(otherList.every((l) => l.id !== trackedLocationIds[0])).toBe(true);
  });

  it('createStaff + createService inherit tenancy + list by location works', async () => {
    const locId = trackedLocationIds[0];
    const staff = await createStaff(ownerSession, {
      locationId: locId,
      name: 'Fixture Staff',
      roleTitle: 'Fixture Role',
    });
    trackedStaffIds.push(staff.id);
    const service = await createService(ownerSession, {
      locationId: locId,
      name: 'Fixture Service',
      price: 42,
      durationMinutes: 45,
    });
    trackedServiceIds.push(service.id);

    const staffList = await listStaff(ownerSession);
    expect(staffList.find((s) => s.id === staff.id)?.locationId).toBe(locId);
  });

  it('setAvailability replaces windows atomically', async () => {
    await setAvailability(ownerSession, trackedStaffIds[0], [
      { weekday: 1, startTime: '09:00', endTime: '12:00' },
      { weekday: 3, startTime: '13:00', endTime: '17:00' },
    ]);
    const [s] = await listStaff(ownerSession);
    const windows = s.availability;
    expect(windows.length).toBe(2);
    expect(windows.map((w) => w.weekday).sort()).toEqual([1, 3]);

    // Second call replaces (not appends).
    await setAvailability(ownerSession, trackedStaffIds[0], [
      { weekday: 5, startTime: '10:00', endTime: '14:00' },
    ]);
    const [s2] = await listStaff(ownerSession);
    expect(s2.availability.length).toBe(1);
    expect(s2.availability[0].weekday).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // 5.3 — validation that was written down and never executed.
  //
  // setAvailability() built a `byDay` map specifically to detect overlaps, then
  // returned without ever comparing two windows. The comment above it said "no
  // overlaps per weekday" for as long as the function has existed.
  // ---------------------------------------------------------------------------
  it('REJECTS overlapping windows on the same weekday', async () => {
    await expect(
      setAvailability(ownerSession, trackedStaffIds[0], [
        { weekday: 1, startTime: '09:00', endTime: '17:00' },
        { weekday: 1, startTime: '13:00', endTime: '14:00' },
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('overlaps') });
  });

  it('allows the same clock times on DIFFERENT weekdays', async () => {
    // The complement: an overlap check that also rejects this would make a
    // normal Mon-Fri schedule unsaveable.
    const r = await setAvailability(ownerSession, trackedStaffIds[0], [
      { weekday: 1, startTime: '09:00', endTime: '17:00' },
      { weekday: 2, startTime: '09:00', endTime: '17:00' },
    ]);
    expect(r.persisted).toBe(2);
  });

  it('allows windows that touch but do not overlap', async () => {
    const r = await setAvailability(ownerSession, trackedStaffIds[0], [
      { weekday: 1, startTime: '09:00', endTime: '12:00' },
      { weekday: 1, startTime: '12:00', endTime: '17:00' },
    ]);
    expect(r.persisted).toBe(2);
  });

  it('REJECTS clock values that match the shape but are not times', async () => {
    // `/^\d{2}:\d{2}$/` accepted every one of these. `new Date(...99:99...)`
    // is an Invalid Date, so the failure surfaced from Prisma, or not at all.
    for (const bad of ['99:99', '25:00', '12:60', '1:00', '0900']) {
      await expect(
        setAvailability(ownerSession, trackedStaffIds[0], [
          { weekday: 1, startTime: bad, endTime: '23:00' },
        ]),
        bad,
      ).rejects.toMatchObject({ name: 'InvalidInputError' });
    }
  });

  it('REJECTS a window that ends at or before it starts', async () => {
    await expect(
      setAvailability(ownerSession, trackedStaffIds[0], [
        { weekday: 1, startTime: '17:00', endTime: '09:00' },
      ]),
    ).rejects.toMatchObject({ name: 'InvalidInputError' });
    await expect(
      setAvailability(ownerSession, trackedStaffIds[0], [
        { weekday: 1, startTime: '09:00', endTime: '09:00' },
      ]),
    ).rejects.toMatchObject({ name: 'InvalidInputError' });
  });

  it('REPORTS how many windows were persisted, including zero', async () => {
    // The editor closed on a resolved promise and showed nothing, so two saves
    // of an empty array were indistinguishable from two successful saves —
    // which is exactly what the availability incident looked like from the UI.
    const some = await setAvailability(ownerSession, trackedStaffIds[0], [
      { weekday: 4, startTime: '08:00', endTime: '23:00' },
    ]);
    expect(some.persisted).toBe(1);

    const none = await setAvailability(ownerSession, trackedStaffIds[0], []);
    expect(none.persisted).toBe(0);
  });

  it('marks the staff member CONFIGURED even when saving an empty schedule', async () => {
    // This is what makes "every day off" enforceable. Without it, clearing the
    // schedule returns the staff member to the legacy fall-through and every
    // hour becomes bookable again.
    await setAvailability(ownerSession, trackedStaffIds[0], []);
    const row = await withoutRls((tx) =>
      tx.staff.findUnique({
        where: { id: trackedStaffIds[0] },
        select: { availabilityConfiguredAt: true },
      }),
    );
    expect(row?.availabilityConfiguredAt).toBeInstanceOf(Date);
  });

  it('stores the LOCAL wall-clock digits that were submitted', async () => {
    // 08:00-23:00 Asia/Tbilisi must read back as 08:00-23:00. It used to be
    // converted to UTC on write (04:00-19:00) and back on read, so the round
    // trip only survived because both halves were wrong in the same direction —
    // and a window whose UTC form crossed midnight was filed on the wrong day.
    await setAvailability(ownerSession, trackedStaffIds[0], [
      { weekday: 2, startTime: '08:00', endTime: '23:00' },
    ]);
    const [s] = await listStaff(ownerSession);
    const w = s.availability.find((x) => x.weekday === 2);
    // listStaff returns the raw Time column; the wall-clock digits are what
    // matter, and they must be the ones submitted rather than offset by 4h.
    const hhmm = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    expect(hhmm(w!.startTime as unknown as Date)).toBe('08:00');
    expect(hhmm(w!.endTime as unknown as Date)).toBe('23:00');
  });

  it('deleteLocation refuses when staff exist (ConflictError 409)', async () => {
    await expect(deleteLocation(ownerSession, trackedLocationIds[0])).rejects.toMatchObject({
      name: 'ConflictError',
    });
  });

  it('createInvitation sends a token-based invite (Phase 4 replacement for inviteMember)', async () => {
    const email = `invited-${Date.now()}@example.dev`;
    const result = await createInvitation(ownerSession, { email, role: 'receptionist' });
    expect(result.url).toMatch(/token=/);

    // Re-inviting the same email while a pending invitation exists → InvalidInputError.
    await expect(
      createInvitation(ownerSession, { email, role: 'practitioner' }),
    ).rejects.toMatchObject({ name: 'InvalidInputError' });
  });

  it('cannot demote or remove yourself (self-protection)', async () => {
    const members = await listMembers(ownerSession);
    const self = members.find((m) => m.userId === userId)!;
    await expect(
      updateMemberRole(ownerSession, self.membershipId, 'receptionist'),
    ).rejects.toMatchObject({
      name: 'InvalidInputError',
    });
    await expect(removeMember(ownerSession, self.membershipId)).rejects.toMatchObject({
      name: 'InvalidInputError',
    });
  });

  // ---------------------------------------------------------------------------
  // P2002 unique-constraint mapping (complement probes for Phase 2)
  // ---------------------------------------------------------------------------
  it('createLocation: duplicate publicSlug → ConflictError, not a raw Prisma error', async () => {
    const slug = `slug-${Date.now()}`;
    const first = await createLocation(ownerSession, {
      type: 'clinic',
      name: 'First',
      publicSlug: slug,
    });
    trackedLocationIds.push(first.id);

    // Complement: same slug from the same org → ConflictError.
    await expect(
      createLocation(ownerSession, { type: 'salon', name: 'Second', publicSlug: slug }),
    ).rejects.toMatchObject({ name: 'ConflictError', message: expect.stringContaining('slug') });
  });

  it('updateLocation: duplicate publicSlug → ConflictError, not a raw Prisma error', async () => {
    const slugA = `sluga-${Date.now()}`;
    const slugB = `slugb-${Date.now()}`;
    const locA = await createLocation(ownerSession, {
      type: 'clinic',
      name: 'LocA',
      publicSlug: slugA,
    });
    const locB = await createLocation(ownerSession, {
      type: 'clinic',
      name: 'LocB',
      publicSlug: slugB,
    });
    trackedLocationIds.push(locA.id, locB.id);

    // Complement: update locB to take locA's slug → ConflictError.
    const { updateLocation } = await import('@/lib/admin');
    await expect(
      updateLocation(ownerSession, locB.id, { type: 'clinic', name: 'LocB', publicSlug: slugA }),
    ).rejects.toMatchObject({ name: 'ConflictError', message: expect.stringContaining('slug') });
  });
});
