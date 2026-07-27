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
  inviteMember,
  listLocations,
  listMembers,
  listStaff,
  removeMember,
  setAvailability,
  updateMemberRole,
} = await import('@/lib/admin');

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
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: 'Admin Fixture Org' } });
      const other = await tx.organization.create({ data: { name: 'Other Admin Org' } });
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: 'admin-owner@bookpitch.dev',
          email: 'admin-owner@bookpitch.dev',
        },
      });
      const otherUser = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: 'other-admin-owner@bookpitch.dev',
          email: 'other-admin-owner@bookpitch.dev',
        },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: user.id, role: 'owner' },
      });
      await tx.membership.create({
        data: { organizationId: other.id, userId: otherUser.id, role: 'owner' },
      });
      return { orgId: org.id, otherId: other.id, userId: user.id, otherUserId: otherUser.id };
    });
    orgId = seed.orgId;
    otherOrgId = seed.otherId;
    userId = seed.userId;
    ownerSession = { organizationId: orgId, userId, email: 'admin-owner@bookpitch.dev', role: 'owner' };
    otherOwnerSession = {
      organizationId: otherOrgId,
      userId: seed.otherUserId,
      email: 'other-admin-owner@bookpitch.dev',
      role: 'owner',
    };
    trackedUserIds.push(userId, seed.otherUserId);

    cleanup.push(async () => {
      await withoutRls((tx) => tx.staffAvailability.deleteMany({ where: { staffId: { in: trackedStaffIds } } }));
      await withoutRls((tx) => tx.staff.deleteMany({ where: { id: { in: trackedStaffIds } } }));
      await withoutRls((tx) => tx.service.deleteMany({ where: { id: { in: trackedServiceIds } } }));
      await withoutRls((tx) => tx.location.deleteMany({ where: { id: { in: trackedLocationIds } } }));
      await withoutRls((tx) =>
        tx.membership.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } }),
      );
      // audit_log is append-only in prod (spec §9.11); dev-only escape
      // hatch releases the FK grip so the fixture users + orgs can go.
      const { resetAuditForOrgs } = await import('./helpers/audit-reset');
      await resetAuditForOrgs([orgId, otherOrgId]);
      await withoutRls((tx) => tx.appUser.deleteMany({ where: { id: { in: trackedUserIds } } }));
      await withoutRls((tx) => tx.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } }));
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

  it('other-org owner cannot see this org\'s locations (RLS)', async () => {
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

  it('deleteLocation refuses when staff exist (ConflictError 409)', async () => {
    await expect(deleteLocation(ownerSession, trackedLocationIds[0])).rejects.toMatchObject({
      name: 'ConflictError',
    });
  });

  it('inviteMember creates app_user + membership (or reuses existing)', async () => {
    const email = `invited-${Date.now()}@example.dev`;
    const result = await inviteMember(ownerSession, {
      email,
      role: 'receptionist',
      tempPassword: 'firstpass1',
    });
    trackedUserIds.push(result.userId);

    const list = await listMembers(ownerSession);
    expect(list.some((m) => m.userId === result.userId)).toBe(true);

    // Re-inviting the same email into the same org → 400-ish InvalidInputError.
    await expect(
      inviteMember(ownerSession, { email, role: 'practitioner', tempPassword: 'anotherpw2' }),
    ).rejects.toMatchObject({ name: 'InvalidInputError' });
  });

  it('cannot demote or remove yourself (self-protection)', async () => {
    const members = await listMembers(ownerSession);
    const self = members.find((m) => m.userId === userId)!;
    await expect(updateMemberRole(ownerSession, self.membershipId, 'receptionist')).rejects.toMatchObject({
      name: 'InvalidInputError',
    });
    await expect(removeMember(ownerSession, self.membershipId)).rejects.toMatchObject({
      name: 'InvalidInputError',
    });
  });
});
