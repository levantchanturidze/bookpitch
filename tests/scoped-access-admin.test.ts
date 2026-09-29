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

const { withoutRls } = await import('@/lib/db');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { ConflictError, InvalidInputError, NotFoundError } = await import('@/lib/auth');
const { linkStaffToMember, unlinkStaff, setMemberBranches, listBranchScopedRoleKeys } =
  await import('@/lib/admin/scoped-access');
const { updateMemberRole } = await import('@/lib/admin');
const { createInvitation, acceptInvitation } = await import('@/lib/invitations');
const { linkStaffAction, setMemberBranchesAction } = await import('@/components/settings/actions');
const appointmentRoute = await import('@/app/api/appointments/[id]/route');

import type { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// C7 — the product flows that make `:own` and `:branch` constructible
// (lib/admin/scoped-access.ts; docs/scoped-rbac-assumption-audit.md §6).
//
// Before this change nothing wrote Staff.userId or membership_branches, so a
// PROVIDER owned nothing and a FRONT_DESK's branch set was always empty. Every
// test here asserts DATABASE state and the audit row — not only the returned
// value — and each refusal sits beside its allow twin.
// -----------------------------------------------------------------------------

type Fx = {
  orgId: string;
  otherOrgId: string;
  owner: { userId: string; membershipId: string };
  coOwner: { userId: string; membershipId: string };
  prov: { userId: string; membershipId: string };
  fd: { userId: string; membershipId: string };
  outsider: string; // a user with no membership in orgId
  locA: string;
  locB: string;
  branchA: string;
  branchB: string;
  otherBranch: string;
  staffA1: string; // at location A
  staffA2: string; // also at location A
  staffB1: string; // at location B
  otherStaff: string; // in the other organisation
  apMine: string; // on staffA1
  apTheirs: string; // on staffB1... reassigned below
};
let fx: Fx;
const ts = Date.now();
const createdUsers: string[] = [];

function session(m: { userId: string; membershipId: string }, orgId = fx.orgId) {
  return {
    userId: m.userId,
    email: `u-${m.userId}@x.invalid`,
    organizationId: orgId,
    membershipId: m.membershipId,
  };
}
async function staffUser(id: string) {
  return (await withoutRls((tx) => tx.staff.findUniqueOrThrow({ where: { id } }))).userId;
}
async function branchesOf(membershipId: string) {
  const rows = await withoutRls((tx) =>
    tx.membershipBranch.findMany({ where: { membershipId }, select: { branchId: true } }),
  );
  return rows.map((r) => r.branchId).sort();
}
async function auditRows(entity: string, entityId: string) {
  return withoutRls((tx) =>
    tx.auditLog.findMany({
      where: { organizationId: fx.orgId, entity, entityId },
      orderBy: { at: 'asc' },
    }),
  );
}
async function sessionVersion(userId: string) {
  return (await withoutRls((tx) => tx.appUser.findUniqueOrThrow({ where: { id: userId } })))
    .sessionVersion;
}

beforeAll(async () => {
  fx = await withoutRls(async (tx) => {
    const role = async (key: string) =>
      (
        await tx.role.findFirstOrThrow({
          where: { key, organizationId: null },
          select: { id: true },
        })
      ).id;
    const rOwner = await role('ORG_OWNER');
    const rProv = await role('PROVIDER');
    const rFd = await role('FRONT_DESK');
    const org = await tx.organization.create({ data: { name: `SA Org ${ts}` } });
    const other = await tx.organization.create({ data: { name: `SA Other ${ts}` } });
    const user = async (tag: string) => {
      const u = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `sa-${tag}-${ts}@bookpitch.dev`,
          email: `sa-${tag}-${ts}@bookpitch.dev`,
        },
        select: { id: true },
      });
      createdUsers.push(u.id);
      return u.id;
    };
    const member = async (
      orgId: string,
      userId: string,
      legacy: 'owner' | 'practitioner' | 'receptionist',
      roleId: string,
    ) =>
      (
        await tx.membership.create({
          data: { organizationId: orgId, userId, role: legacy, roleId },
          select: { id: true },
        })
      ).id;

    const ownerId = await user('owner');
    const coOwnerId = await user('coowner');
    const provId = await user('prov');
    const fdId = await user('fd');
    const outsider = await user('outsider');
    const owner = { userId: ownerId, membershipId: await member(org.id, ownerId, 'owner', rOwner) };
    const coOwner = {
      userId: coOwnerId,
      membershipId: await member(org.id, coOwnerId, 'owner', rOwner),
    };
    const prov = {
      userId: provId,
      membershipId: await member(org.id, provId, 'practitioner', rProv),
    };
    const fd = { userId: fdId, membershipId: await member(org.id, fdId, 'receptionist', rFd) };
    await member(other.id, outsider, 'owner', rOwner);

    const loc = (orgId: string, name: string) =>
      tx.location.create({
        data: { organizationId: orgId, type: 'clinic', name },
        select: { id: true },
      });
    const locA = (await loc(org.id, 'SA A')).id;
    const locB = (await loc(org.id, 'SA B')).id;
    const otherLoc = (await loc(other.id, 'SA Other')).id;
    const branch = async (locationId: string) =>
      (await tx.branch.findFirstOrThrow({ where: { legacyLocationId: locationId } })).id;
    const staff = (orgId: string, locationId: string, name: string) =>
      tx.staff.create({
        data: { organizationId: orgId, locationId, name, roleTitle: 'Clinician' },
        select: { id: true },
      });
    const staffA1 = (await staff(org.id, locA, 'SA A1')).id;
    const staffA2 = (await staff(org.id, locA, 'SA A2')).id;
    const staffB1 = (await staff(org.id, locB, 'SA B1')).id;
    const otherStaff = (await staff(other.id, otherLoc, 'SA Other staff')).id;
    const customer = await tx.customer.create({
      data: { organizationId: org.id, name: 'SA Customer' },
    });
    const appt = (locationId: string, staffId: string, hour: number) =>
      tx.appointment.create({
        data: {
          organizationId: org.id,
          locationId,
          customerId: customer.id,
          staffId,
          serviceName: 'SA',
          price: 10,
          startsAt: new Date(Date.UTC(2031, 2, 3, hour)),
          endsAt: new Date(Date.UTC(2031, 2, 3, hour, 30)),
        },
        select: { id: true },
      });
    return {
      orgId: org.id,
      otherOrgId: other.id,
      owner,
      coOwner,
      prov,
      fd,
      outsider,
      locA,
      locB,
      branchA: await branch(locA),
      branchB: await branch(locB),
      otherBranch: await branch(otherLoc),
      staffA1,
      staffA2,
      staffB1,
      otherStaff,
      apMine: (await appt(locA, staffA1, 8)).id,
      apTheirs: (await appt(locA, staffA2, 9)).id,
    };
  });
});

afterAll(async () => {
  if (!fx) return;
  const orgs = [fx.orgId, fx.otherOrgId];
  await withoutRls(async (tx) => {
    await tx.invitation.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.appointment.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.customer.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.staff.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.location.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.membership.deleteMany({ where: { organizationId: { in: orgs } } });
    await tx.organization.updateMany({ where: { id: { in: orgs } }, data: { ownerUserId: null } });
  });
  const { resetAuditForOrgs } = await import('./helpers/audit-reset');
  await resetAuditForOrgs(orgs);
  await withoutRls(async (tx) => {
    await tx.appUser.deleteMany({ where: { id: { in: createdUsers } } });
    await tx.organization.deleteMany({ where: { id: { in: orgs } } });
  });
});

beforeEach(() => {
  authMock.mockReset();
  __clearAuthContextCache();
  vi.stubEnv('EMAIL_PROVIDER', 'mock');
  vi.stubEnv('SMS_PROVIDER', 'mock');
});

// -----------------------------------------------------------------------------
describe('staff ↔ member link', () => {
  async function patchAs(userId: string, appointmentId: string) {
    authMock.mockResolvedValue(await mockJwt(userId, fx.orgId));
    __clearAuthContextCache();
    return (
      await appointmentRoute.PATCH(
        new Request(`http://x/api/appointments/${appointmentId}`, {
          method: 'PATCH',
          body: JSON.stringify({ notes: 'sa' }),
          headers: { 'content-type': 'application/json' },
        }) as unknown as NextRequest,
        { params: Promise.resolve({ id: appointmentId }) },
      )
    ).status;
  }

  it('before any link the PROVIDER owns nothing — their own booking is refused (U-05 posture)', async () => {
    expect(await patchAs(fx.prov.userId, fx.apMine)).toBe(403);
  });

  it('linking through the product flow makes own-allow real, and own-deny stays', async () => {
    const r = await linkStaffToMember(session(fx.owner), fx.staffA1, fx.prov.userId);
    expect(r).toEqual({ staffId: fx.staffA1, userId: fx.prov.userId, changed: true });
    expect(await staffUser(fx.staffA1)).toBe(fx.prov.userId);
    const audit = await auditRows('staff', fx.staffA1);
    expect(audit.at(-1)).toMatchObject({ action: 'update', actorUserId: fx.owner.userId });
    expect(audit.at(-1)?.meta).toMatchObject({
      link: { userId: fx.prov.userId, membershipId: fx.prov.membershipId },
    });

    expect(await patchAs(fx.prov.userId, fx.apMine)).toBe(200); // own-allow
    expect(await patchAs(fx.prov.userId, fx.apTheirs)).toBe(403); // own-deny
  });

  it('linking again to the same member changes nothing and writes no audit row', async () => {
    const before = (await auditRows('staff', fx.staffA1)).length;
    expect(await linkStaffToMember(session(fx.owner), fx.staffA1, fx.prov.userId)).toMatchObject({
      changed: false,
    });
    expect((await auditRows('staff', fx.staffA1)).length).toBe(before);
  });

  it('a staff record linked to someone else cannot be silently taken over', async () => {
    await expect(
      linkStaffToMember(session(fx.owner), fx.staffA1, fx.fd.userId),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await staffUser(fx.staffA1)).toBe(fx.prov.userId);
  });

  it('one person, two staff records at ONE location — refused by staff_location_user_unique', async () => {
    await expect(linkStaffToMember(session(fx.owner), fx.staffA2, fx.prov.userId)).rejects.toThrow(
      /already linked to another staff record at this location/,
    );
    expect(await staffUser(fx.staffA2)).toBeNull();
  });

  it('one person at a SECOND location — allowed (the multi-location practitioner)', async () => {
    await linkStaffToMember(session(fx.owner), fx.staffB1, fx.prov.userId);
    expect(await staffUser(fx.staffB1)).toBe(fx.prov.userId);
    expect(await staffUser(fx.staffA1)).toBe(fx.prov.userId);
  });

  it('a user with no membership in this organisation is refused', async () => {
    await expect(
      linkStaffToMember(session(fx.owner), fx.staffA2, fx.outsider),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(await staffUser(fx.staffA2)).toBeNull();
  });

  it("another organisation's staff record is not found — tenant isolation first", async () => {
    await expect(
      linkStaffToMember(session(fx.owner), fx.otherStaff, fx.prov.userId),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await staffUser(fx.otherStaff)).toBeNull();
  });

  it('nobody links a record to themselves, or to a member of equal rank (invariant 4)', async () => {
    await expect(linkStaffToMember(session(fx.owner), fx.staffA2, fx.owner.userId)).rejects.toThrow(
      /your own/,
    );
    await expect(
      linkStaffToMember(session(fx.owner), fx.staffA2, fx.coOwner.userId),
    ).rejects.toThrow(/cannot change/);
    expect(await staffUser(fx.staffA2)).toBeNull();
  });

  it('the Server Action refuses a member without staff.role.assign — and serves the owner', async () => {
    authMock.mockResolvedValue(await mockJwt(fx.fd.userId, fx.orgId));
    expect(await linkStaffAction(fx.staffA2, fx.fd.userId)).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(await staffUser(fx.staffA2)).toBeNull();
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockJwt(fx.owner.userId, fx.orgId));
    expect(await linkStaffAction(fx.staffA2, fx.fd.userId)).toMatchObject({ ok: true });
    expect(await staffUser(fx.staffA2)).toBe(fx.fd.userId);
  });

  it('unlink clears the link, audits it, and is idempotent', async () => {
    expect(await unlinkStaff(session(fx.owner), fx.staffA2)).toMatchObject({ changed: true });
    expect(await staffUser(fx.staffA2)).toBeNull();
    expect((await auditRows('staff', fx.staffA2)).at(-1)?.meta).toMatchObject({
      unlink: { userId: fx.fd.userId },
    });
    expect(await unlinkStaff(session(fx.owner), fx.staffA2)).toMatchObject({ changed: false });
  });
});

// -----------------------------------------------------------------------------
describe('membership branches', () => {
  it('the Members panel learns which roles are branch-scoped from role_permissions', async () => {
    // Read through the tenant client (the app role), not a privileged one: the
    // reference tables carry no RLS and the app role holds SELECT on them.
    expect(await listBranchScopedRoleKeys(session(fx.owner))).toEqual([
      'BRANCH_MANAGER',
      'FRONT_DESK',
      'SENIOR_PROVIDER',
    ]);
  });

  it('assigns same-organisation branches, audits them, and ends the live session', async () => {
    const sv = await sessionVersion(fx.fd.userId);
    const r = await setMemberBranches(session(fx.owner), fx.fd.membershipId, [fx.branchA]);
    expect(r).toEqual({ added: [fx.branchA], removed: [] });
    expect(await branchesOf(fx.fd.membershipId)).toEqual([fx.branchA]);
    expect((await auditRows('membership', fx.fd.membershipId)).at(-1)?.meta).toMatchObject({
      targetUserId: fx.fd.userId,
      branches: { added: [fx.branchA], removed: [] },
    });
    expect(await sessionVersion(fx.fd.userId)).toBe(sv + 1);
  });

  it('assigning the same set again changes nothing — no audit row, no session bump', async () => {
    const sv = await sessionVersion(fx.fd.userId);
    const audits = (await auditRows('membership', fx.fd.membershipId)).length;
    expect(
      await setMemberBranches(session(fx.owner), fx.fd.membershipId, [fx.branchA, fx.branchA]),
    ).toEqual({
      added: [],
      removed: [],
    });
    expect((await auditRows('membership', fx.fd.membershipId)).length).toBe(audits);
    expect(await sessionVersion(fx.fd.userId)).toBe(sv);
  });

  it("another organisation's branch is refused, and nothing changes", async () => {
    await expect(
      setMemberBranches(session(fx.owner), fx.fd.membershipId, [fx.branchA, fx.otherBranch]),
    ).rejects.toThrow(/not in this organisation/);
    expect(await branchesOf(fx.fd.membershipId)).toEqual([fx.branchA]);
  });

  it('the database refuses a cross-organisation scope even when the code is bypassed', async () => {
    await expect(
      withoutRls((tx) =>
        tx.membershipBranch.create({
          data: { membershipId: fx.fd.membershipId, branchId: fx.otherBranch },
        }),
      ),
    ).rejects.toThrow(/not in the same organisation/);
  });

  it('swaps and removes, auditing both halves; an empty set is allowed (fail-closed)', async () => {
    expect(await setMemberBranches(session(fx.owner), fx.fd.membershipId, [fx.branchB])).toEqual({
      added: [fx.branchB],
      removed: [fx.branchA],
    });
    expect(await setMemberBranches(session(fx.owner), fx.fd.membershipId, [])).toEqual({
      added: [],
      removed: [fx.branchB],
    });
    expect(await branchesOf(fx.fd.membershipId)).toEqual([]);
  });

  it('refuses yourself and a peer (invariant 4), and a membership of another organisation', async () => {
    await expect(
      setMemberBranches(session(fx.owner), fx.owner.membershipId, [fx.branchA]),
    ).rejects.toThrow(/your own/);
    await expect(
      setMemberBranches(session(fx.owner), fx.coOwner.membershipId, [fx.branchA]),
    ).rejects.toThrow(/cannot change/);
    const otherMembership = (
      await withoutRls((tx) =>
        tx.membership.findFirstOrThrow({ where: { organizationId: fx.otherOrgId } }),
      )
    ).id;
    await expect(setMemberBranches(session(fx.owner), otherMembership, [])).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('the Server Action refuses a member without staff.role.assign', async () => {
    authMock.mockResolvedValue(await mockJwt(fx.prov.userId, fx.orgId));
    expect(await setMemberBranchesAction(fx.fd.membershipId, [fx.branchA])).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(await branchesOf(fx.fd.membershipId)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('owner decision D1 — a FRONT_DESK membership starts with every branch', () => {
  const token = (url: string) => decodeURIComponent(new URL(url).searchParams.get('token') ?? '');

  it('accepting a receptionist invitation assigns every current branch, audited', async () => {
    const email = `sa-invited-fd-${ts}@bookpitch.dev`;
    const inv = await createInvitation(session(fx.owner), { email, role: 'receptionist' });
    const accepted = await acceptInvitation({
      token: token(inv.url),
      password: 'sa-password-1',
      fullName: 'SA FD',
    });
    createdUsers.push(accepted.userId);
    const m = await withoutRls((tx) =>
      tx.membership.findFirstOrThrow({
        where: { organizationId: fx.orgId, userId: accepted.userId },
      }),
    );
    expect(await branchesOf(m.id)).toEqual([fx.branchA, fx.branchB].sort());
    expect((await auditRows('membership', m.id)).at(-1)).toMatchObject({
      actorUserId: accepted.userId,
      meta: { source: 'invitation-default' },
    });
  });

  it('accepting a practitioner invitation assigns nothing — branches do not scope :own', async () => {
    const email = `sa-invited-prov-${ts}@bookpitch.dev`;
    const inv = await createInvitation(session(fx.owner), { email, role: 'practitioner' });
    const accepted = await acceptInvitation({
      token: token(inv.url),
      password: 'sa-password-1',
      fullName: 'SA P',
    });
    createdUsers.push(accepted.userId);
    const m = await withoutRls((tx) =>
      tx.membership.findFirstOrThrow({
        where: { organizationId: fx.orgId, userId: accepted.userId },
      }),
    );
    expect(await branchesOf(m.id)).toEqual([]);
  });

  it('a role change INTO front desk assigns every branch; an existing scope is never widened', async () => {
    // prov has no scope: becomes FRONT_DESK -> every branch.
    await updateMemberRole(session(fx.owner), fx.prov.membershipId, 'receptionist');
    expect(await branchesOf(fx.prov.membershipId)).toEqual([fx.branchA, fx.branchB].sort());
    expect((await auditRows('membership', fx.prov.membershipId)).at(-1)?.meta).toMatchObject({
      source: 'role-default',
    });

    // fd is narrowed to B, becomes a practitioner, then front desk again: B stays B.
    await setMemberBranches(session(fx.owner), fx.fd.membershipId, [fx.branchB]);
    await updateMemberRole(session(fx.owner), fx.fd.membershipId, 'practitioner');
    await updateMemberRole(session(fx.owner), fx.fd.membershipId, 'receptionist');
    expect(await branchesOf(fx.fd.membershipId)).toEqual([fx.branchB]);
  });
});
