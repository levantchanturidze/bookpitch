import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { can } = await import('@/lib/rbac/can');
const { perm } = await import('@/lib/rbac/types');
const { appointmentResource, resolveAppointmentResource } = await import('@/lib/rbac/scope');
const { withoutRls } = await import('@/lib/db');
const { createLocation, createStaff, createService } = await import('@/lib/admin');
type AuthContext = import('@/lib/rbac/types').AuthContext;
type PermissionKey = import('@/lib/rbac/types').PermissionKey;

// -----------------------------------------------------------------------------
// U-05 regression — found by the C7 production UAT on 2026-09-26.
//
// A PROVIDER holding only booking.update:own / booking.cancel:own UPDATED and
// CANCELLED appointments assigned to another staff member, against production,
// HTTP 200 both times — while its own list endpoint returned []. Read scoping
// worked; write scoping did not.
//
// Three facts composed:
//   1. Nothing in this product ever writes Staff.userId, so every appointment
//      has an unlinked owner.
//   2. appointmentResource() OMITTED ownerUserId when the owner was null.
//   3. can() 4c read `if (!resource?.ownerUserId) return true` — list mode.
//
// tests/scheduler-resource-scope.test.ts already covered `:own` deny and allow,
// and passed throughout, because every one of its cases supplies an explicit
// ownerUserId string. It never built the shape the product actually produces.
// That is the gap these tests close, so the fixture is derived from the
// RESOLVER's real output rather than from a hand-written resource literal.
// -----------------------------------------------------------------------------

const ME = 'user-me';
const SOMEONE_ELSE = 'user-other';

function providerCtx(orgId: string, userId = ME): AuthContext {
  return {
    userId,
    email: 'me@bp.test',
    membershipId: 'm1',
    activeOrganizationId: orgId,
    roleKey: 'PROVIDER',
    roleRank: 40,
    permissions: new Set(
      ['booking.update:own', 'booking.cancel:own', 'booking.read:own'].map(perm),
    ) as ReadonlySet<PermissionKey>,
    platformPermissions: new Set() as ReadonlySet<PermissionKey>,
    branchIds: new Set() as ReadonlySet<string>,
    impersonation: null,
    isImpersonating: false,
    breakGlass: null,
    isBreakGlass: false,
    sessionVersion: 1,
    authSessionId: 's1',
    organizationStatus: 'active',
    orgToggles: {},
  } as unknown as AuthContext;
}

describe('U-05 — :own must not grant on a resolved-but-unowned resource', () => {
  const ORG = '00000000-0000-0000-0000-0000000000aa';

  it('DENIES a concrete appointment whose staff has no linked user', () => {
    const resource = appointmentResource(ORG, { ownerUserId: null, locationId: 'loc-1' });
    expect(resource).toHaveProperty('ownerUserId', null);
    expect(can(providerCtx(ORG), 'booking.update', resource)).toBe(false);
    expect(can(providerCtx(ORG), 'booking.cancel', resource)).toBe(false);
  });

  it('still ALLOWS list mode, where no resource was named at all', () => {
    // The complement. Removing the fallback outright would leave a :own role
    // unable to list anything, which is why it exists.
    expect(can(providerCtx(ORG), 'booking.update', { organizationId: ORG })).toBe(true);
    const listShape = appointmentResource(ORG, { locationId: 'loc-1' });
    expect('ownerUserId' in listShape).toBe(false);
    expect(can(providerCtx(ORG), 'booking.update', listShape)).toBe(true);
  });

  it('ALLOWS an appointment the caller does own', () => {
    const mine = appointmentResource(ORG, { ownerUserId: ME, locationId: 'loc-1' });
    expect(can(providerCtx(ORG), 'booking.update', mine)).toBe(true);
  });

  it("DENIES another user's appointment (the case that already worked)", () => {
    const theirs = appointmentResource(ORG, { ownerUserId: SOMEONE_ELSE, locationId: 'loc-1' });
    expect(can(providerCtx(ORG), 'booking.update', theirs)).toBe(false);
  });

  it('appointmentResource distinguishes absent from null', () => {
    expect('ownerUserId' in appointmentResource(ORG, {})).toBe(false);
    expect('ownerUserId' in appointmentResource(ORG, { ownerUserId: null })).toBe(true);
    expect(appointmentResource(ORG, { ownerUserId: null }).ownerUserId).toBeNull();
    expect(appointmentResource(ORG, { ownerUserId: undefined }).ownerUserId).toBeNull();
  });

  it('an :org role is unaffected', () => {
    const owner = {
      ...providerCtx(ORG),
      roleKey: 'ORG_OWNER',
      roleRank: 100,
      permissions: new Set(['booking.update:org'].map(perm)) as ReadonlySet<PermissionKey>,
    } as unknown as AuthContext;
    const unowned = appointmentResource(ORG, { ownerUserId: null, locationId: 'loc-1' });
    expect(can(owner, 'booking.update', unowned)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The end-to-end half: build the resource from the REAL resolver against a real
// appointment created through the real admin API, exactly as production does.
// -----------------------------------------------------------------------------
describe('U-05 — the shape the product actually produces', () => {
  let orgId: string;
  let userId: string;
  let appointmentId: string;

  beforeAll(async () => {
    const ts = Date.now();
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `U05 Org ${ts}` } });
      const u = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `u05-${ts}@bookpitch.dev`,
          email: `u05-${ts}@bookpitch.dev`,
        },
      });
      const r = await tx.role.findFirstOrThrow({
        where: { key: 'ORG_OWNER', organizationId: null },
        select: { id: true },
      });
      const m = await tx.membership.create({
        data: { organizationId: org.id, userId: u.id, role: 'owner', roleId: r.id },
      });
      const c = await tx.customer.create({
        data: { organizationId: org.id, name: 'U05 Customer' },
      });
      return { orgId: org.id, userId: u.id, mId: m.id, customerId: c.id };
    });
    orgId = seed.orgId;
    userId = seed.userId;
    const session = {
      organizationId: orgId,
      userId,
      email: `u05-${Date.now()}@bookpitch.dev`,
      membershipId: seed.mId,
    };
    const loc = await createLocation(session, {
      type: 'clinic',
      name: 'U05 Location',
      timezone: 'Asia/Tbilisi',
    });
    // Created through the real admin API — which offers no way to link a user.
    const staff = await createStaff(session, {
      locationId: loc.id,
      name: 'U05 Staff',
      roleTitle: 'Clinician',
    });
    const svc = await createService(session, {
      locationId: loc.id,
      name: 'U05 Service',
      price: 10,
      durationMinutes: 30,
    });
    const appt = await withoutRls((tx) =>
      tx.appointment.create({
        data: {
          organizationId: orgId,
          locationId: loc.id,
          customerId: seed.customerId,
          staffId: staff.id,
          serviceId: svc.id,
          serviceName: svc.name,
          startsAt: new Date('2026-12-05T09:00:00.000Z'),
          endsAt: new Date('2026-12-05T09:30:00.000Z'),
          price: 10,
        },
        select: { id: true },
      }),
    );
    appointmentId = appt.id;
  });

  afterAll(async () => {
    await withoutRls((tx) => tx.appointment.deleteMany({ where: { organizationId: orgId } }));
    await withoutRls((tx) => tx.customer.deleteMany({ where: { organizationId: orgId } }));
    await withoutRls((tx) => tx.service.deleteMany({ where: { organizationId: orgId } }));
    await withoutRls((tx) => tx.staff.deleteMany({ where: { organizationId: orgId } }));
    await withoutRls((tx) => tx.location.deleteMany({ where: { organizationId: orgId } }));
    await withoutRls(async (tx) => {
      await tx.membership.deleteMany({ where: { organizationId: orgId } });
      await tx.organization.updateMany({ where: { id: orgId }, data: { ownerUserId: null } });
    });
    const { resetAuditForOrgs } = await import('./helpers/audit-reset');
    await resetAuditForOrgs([orgId]);
    await withoutRls((tx) => tx.appUser.deleteMany({ where: { id: userId } }));
    await withoutRls((tx) => tx.organization.deleteMany({ where: { id: orgId } }));
  });

  it('staff created through the product have no linked user — the premise of U-05', async () => {
    const staff = await withoutRls((tx) =>
      tx.staff.findFirstOrThrow({
        where: { organizationId: orgId },
        select: { userId: true },
      }),
    );
    expect(staff.userId).toBeNull();
  });

  it('the resolver marks it resolved-and-unowned, and a :own provider is refused', async () => {
    const resource = await resolveAppointmentResource(appointmentId, orgId);
    expect(resource).not.toBeNull();
    // Present and null — not absent. This is the assertion that would have
    // caught U-05 before it reached production.
    expect('ownerUserId' in resource!).toBe(true);
    expect(resource!.ownerUserId).toBeNull();

    expect(can(providerCtx(orgId), 'booking.update', resource!)).toBe(false);
    expect(can(providerCtx(orgId), 'booking.cancel', resource!)).toBe(false);
  });
});
