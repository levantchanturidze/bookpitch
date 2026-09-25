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
  updateLocation,
  deleteLocation,
  createService,
  updateService,
  createStaff,
  updateStaff,
  setAvailability,
  updateMemberRole,
} = await import('@/lib/admin');
const { AUDIT_ENTITIES } = await import('@/lib/audit');

// -----------------------------------------------------------------------------
// U-03 regression — production UAT 2026-09-25.
//
// Every mutation in lib/admin.ts used to write entity='staff'. A service
// creation appeared in /audit as `create staff —`, locations and MEMBERSHIP
// ROLE CHANGES likewise, with entity_id null and the real identifier demoted
// into meta. Membership role changes are privilege changes, so this made the
// append-only compliance record misdescribe exactly the events it exists for.
//
// These tests assert on the AUDIT ROW ITSELF — the artefact an auditor reads —
// not on the arguments passed to writeAudit. A test that mocked writeAudit
// would have passed against the broken code.
// -----------------------------------------------------------------------------

type Session = {
  organizationId: string;
  userId: string;
  email: string;
  membershipId: string;
};

type AuditRow = { action: string; entity: string; entityId: string | null; meta: unknown };

describe('U-03 audit entity taxonomy', () => {
  let orgId: string;
  let ownerSession: Session;
  let memberUserId: string;
  let memberMembershipId: string;
  const trackedUserIds: string[] = [];

  /** Audit rows for this org, newest first. Reads the real table. */
  async function auditRows(): Promise<AuditRow[]> {
    return withoutRls(async (tx) =>
      tx.auditLog.findMany({
        where: { organizationId: orgId },
        select: { action: true, entity: true, entityId: true, meta: true },
        orderBy: { at: 'desc' },
        take: 50,
      }),
    ) as Promise<AuditRow[]>;
  }

  async function rowFor(action: string, entity: string): Promise<AuditRow | undefined> {
    return (await auditRows()).find((r) => r.action === action && r.entity === entity);
  }

  beforeAll(async () => {
    const ts = Date.now();
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `Audit Taxonomy Org ${ts}` } });
      const owner = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `audit-tax-owner-${ts}@bookpitch.dev`,
          email: `audit-tax-owner-${ts}@bookpitch.dev`,
        },
      });
      const member = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `audit-tax-member-${ts}@bookpitch.dev`,
          email: `audit-tax-member-${ts}@bookpitch.dev`,
        },
      });
      const ownerRole = await tx.role.findFirstOrThrow({
        where: { key: 'ORG_OWNER', organizationId: null },
        select: { id: true },
      });
      const deskRole = await tx.role.findFirstOrThrow({
        where: { key: 'FRONT_DESK', organizationId: null },
        select: { id: true },
      });
      const ownerMembership = await tx.membership.create({
        data: { organizationId: org.id, userId: owner.id, role: 'owner', roleId: ownerRole.id },
      });
      const memberMembership = await tx.membership.create({
        data: {
          organizationId: org.id,
          userId: member.id,
          role: 'receptionist',
          roleId: deskRole.id,
        },
      });
      return {
        orgId: org.id,
        ownerId: owner.id,
        ownerMembershipId: ownerMembership.id,
        memberId: member.id,
        membershipId: memberMembership.id,
        email: `audit-tax-owner-${ts}@bookpitch.dev`,
      };
    });
    orgId = seed.orgId;
    memberUserId = seed.memberId;
    memberMembershipId = seed.membershipId;
    ownerSession = {
      organizationId: orgId,
      userId: seed.ownerId,
      email: seed.email,
      // updateMemberRole resolves the ACTOR's AuthContext from this, so the
      // rank/lattice guard runs for real rather than being skipped.
      membershipId: seed.ownerMembershipId,
    };
    trackedUserIds.push(seed.ownerId, seed.memberId);
  });

  afterAll(async () => {
    await withoutRls((tx) =>
      tx.staffAvailability.deleteMany({ where: { staff: { organizationId: orgId } } }),
    );
    await withoutRls((tx) => tx.staff.deleteMany({ where: { organizationId: orgId } }));
    await withoutRls((tx) => tx.service.deleteMany({ where: { organizationId: orgId } }));
    await withoutRls((tx) => tx.location.deleteMany({ where: { organizationId: orgId } }));
    // Invariant 5 is bidirectional: an org may not keep owner_user_id without an
    // active owner membership, NOR have members with owner_user_id cleared. Both
    // sides must therefore move inside ONE transaction, where the deferred check
    // sees the consistent end state rather than either half-step.
    await withoutRls(async (tx) => {
      await tx.membership.deleteMany({ where: { organizationId: orgId } });
      await tx.organization.updateMany({ where: { id: orgId }, data: { ownerUserId: null } });
    });
    const { resetAuditForOrgs } = await import('./helpers/audit-reset');
    await resetAuditForOrgs([orgId]);
    await withoutRls((tx) => tx.appUser.deleteMany({ where: { id: { in: trackedUserIds } } }));
    await withoutRls((tx) => tx.organization.deleteMany({ where: { id: orgId } }));
  });

  it('service create and update log entity=service with the service id', async () => {
    const location = await createLocation(ownerSession, {
      type: 'clinic',
      name: 'Taxonomy Location',
      timezone: 'Asia/Tbilisi',
    });
    const service = await createService(ownerSession, {
      locationId: location.id,
      name: 'Taxonomy Service',
      price: 50,
      durationMinutes: 30,
    });

    const created = await rowFor('create', 'service');
    expect(created, 'a service creation must be filterable as entity=service').toBeDefined();
    expect(created!.entityId).toBe(service.id);

    await updateService(ownerSession, service.id, {
      locationId: location.id,
      name: 'Taxonomy Service Renamed',
      price: 60,
      durationMinutes: 30,
    });
    const updated = await rowFor('update', 'service');
    expect(updated).toBeDefined();
    expect(updated!.entityId).toBe(service.id);

    // The complement: the old bug wrote these as `staff`. Prove no service
    // mutation is hiding under the staff label.
    const staffRows = (await auditRows()).filter((r) => r.entity === 'staff');
    expect(staffRows.some((r) => JSON.stringify(r.meta ?? {}).includes('service'))).toBe(false);
  });

  it('location create/update/delete log entity=location with the location id', async () => {
    const location = await createLocation(ownerSession, {
      type: 'clinic',
      name: 'Disposable Location',
      timezone: 'Asia/Tbilisi',
    });
    const created = await rowFor('create', 'location');
    expect(created).toBeDefined();
    expect(created!.entityId).toBe(location.id);

    await updateLocation(ownerSession, location.id, {
      type: 'clinic',
      name: 'Disposable Location Renamed',
      timezone: 'Asia/Tbilisi',
    });
    const updated = await rowFor('update', 'location');
    expect(updated!.entityId).toBe(location.id);

    await deleteLocation(ownerSession, location.id);
    const deleted = await rowFor('delete', 'location');
    expect(deleted!.entityId).toBe(location.id);
  });

  it('membership role changes are independently filterable and carry the membership id', async () => {
    await updateMemberRole(ownerSession, memberMembershipId, 'practitioner');

    const rows = await auditRows();
    const membershipRows = rows.filter((r) => r.entity === 'membership');
    expect(
      membershipRows.length,
      'a privilege change must be reachable by filtering entity=membership alone',
    ).toBeGreaterThan(0);

    const row = membershipRows[0];
    // The authoritative object for a role grant is the membership, not the user.
    expect(row.entityId).toBe(memberMembershipId);
    // The affected user and the transition stay recoverable.
    const meta = row.meta as Record<string, unknown>;
    expect(meta.targetUserId).toBe(memberUserId);
    expect(meta.role).toBe('practitioner');
    expect(meta).toHaveProperty('previousRole');
  });

  it('staff mutations still log entity=staff with the staff id', async () => {
    const location = await createLocation(ownerSession, {
      type: 'clinic',
      name: 'Staff Location',
      timezone: 'Asia/Tbilisi',
    });
    const staff = await createStaff(ownerSession, {
      locationId: location.id,
      name: 'Taxonomy Staff',
      roleTitle: 'Taxonomy Role',
    });

    const created = await rowFor('create', 'staff');
    expect(created).toBeDefined();
    expect(created!.entityId).toBe(staff.id);

    await updateStaff(ownerSession, staff.id, {
      locationId: location.id,
      name: 'Renamed Staff',
      roleTitle: 'Taxonomy Role',
    });
    const updated = await rowFor('update', 'staff');
    expect(updated!.entityId).toBe(staff.id);

    await setAvailability(ownerSession, staff.id, [
      { weekday: 6, startTime: '09:00', endTime: '18:00' },
    ]);
    const avail = (await auditRows()).find(
      (r) => r.entity === 'staff' && JSON.stringify(r.meta ?? {}).includes('availability'),
    );
    expect(avail).toBeDefined();
    expect(avail!.entityId).toBe(staff.id);
  });

  it('no audit row written by this suite uses an entity outside the declared taxonomy', async () => {
    const rows = await auditRows();
    expect(rows.length).toBeGreaterThan(0);
    const unknown = rows.map((r) => r.entity).filter((e) => !AUDIT_ENTITIES.includes(e as never));
    expect(unknown, `entities outside AUDIT_ENTITIES: ${unknown.join(', ')}`).toEqual([]);
  });

  it('every audit row for an object with an authoritative id populates entity_id', async () => {
    // list/read-style rows legitimately have a null entity_id (they are about a
    // collection). Mutations of a concrete object must not.
    const rows = await auditRows();
    const mutations = rows.filter((r) => ['create', 'update', 'delete'].includes(r.action));
    expect(mutations.length).toBeGreaterThan(0);
    const missing = mutations.filter((r) => r.entityId === null);
    expect(
      missing.map((r) => `${r.action} ${r.entity}`),
      'mutations must carry the id of the object they changed',
    ).toEqual([]);
  });
});
