import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { unsafePrismaAdmin } = await import('@/lib/db');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const {
  nominateTransfer, acceptTransfer, declineTransfer, revokeTransfer, pendingTransfersForNominee,
} = await import('@/lib/admin/ownership-transfer');
const { ConflictError, InvalidInputError } = await import('@/lib/auth');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');

// -----------------------------------------------------------------------------
// Phase 6 spec §4.2 — two-step ownership transfer (nominate + accept).
// Guardrails:
//   • Only the current org owner can nominate.
//   • Target must be an active member.
//   • One pending transfer per org (DB-enforced + app-level friendlier error).
//   • Accept swaps roles atomically, bumps both sessionVersions.
//   • Decline / revoke close the transfer without touching memberships.
//   • Expired pending row is refused on accept and marked expired.
// -----------------------------------------------------------------------------

describe('ownership transfer', () => {
  let orgId: string;
  let ownerUserId: string;
  let ownerMembershipId: string;
  let targetUserId: string;
  let targetMembershipId: string;
  let outsiderUserId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const org = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' }, select: { id: true },
    });
    orgId = org.id;
    ownerUserId = (await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'split-owner@bp.test' },
    })).id;
    ownerMembershipId = (await unsafePrismaAdmin.membership.findFirstOrThrow({
      where: { userId: ownerUserId, organizationId: orgId },
    })).id;
    const target = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'moonlight@bp.test' },
    });
    targetUserId = target.id;
    targetMembershipId = (await unsafePrismaAdmin.membership.findFirstOrThrow({
      where: { userId: target.id, organizationId: orgId },
    })).id;
    // Non-member for negative tests.
    outsiderUserId = (await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'solo@bp.test' },
    })).id;
  });

  beforeEach(async () => {
    __clearAuthContextCache();
    // Wipe any leftover pending / accepted transfers so each test starts fresh.
    await unsafePrismaAdmin.ownershipTransfer.deleteMany({ where: { organizationId: orgId } });
    // Restore Split Practice owner + roles to the fixture state.
    const orgOwnerRole = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
    });
    const providerRole = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'PROVIDER', organizationId: null },
    });
    await unsafePrismaAdmin.organization.update({
      where: { id: orgId }, data: { ownerUserId },
    });
    await unsafePrismaAdmin.membership.update({
      where: { id: ownerMembershipId },
      data: { role: 'owner', roleId: orgOwnerRole.id },
    });
    await unsafePrismaAdmin.membership.update({
      where: { id: targetMembershipId },
      data: { role: 'practitioner', roleId: providerRole.id },
    });
  });

  afterAll(async () => {
    await unsafePrismaAdmin.ownershipTransfer.deleteMany({ where: { organizationId: orgId } });
  });

  const ownerSession = () => ({
    userId: ownerUserId, email: 'split-owner@bp.test',
    organizationId: orgId, membershipId: ownerMembershipId,
  });
  const targetSession = () => ({
    userId: targetUserId, email: 'moonlight@bp.test',
    organizationId: orgId, membershipId: targetMembershipId,
  });

  it('nominate rejects self-nomination', async () => {
    await expect(nominateTransfer(ownerSession(), ownerUserId)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('nominate rejects a non-member target', async () => {
    await expect(nominateTransfer(ownerSession(), outsiderUserId)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('nominate refuses a second pending transfer for the same org', async () => {
    await nominateTransfer(ownerSession(), targetUserId);
    await expect(nominateTransfer(ownerSession(), targetUserId)).rejects.toBeInstanceOf(ConflictError);
  });

  it('accept swaps ownership + roles + bumps both sessionVersions', async () => {
    const beforeOwnerSV = (await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: ownerUserId }, select: { sessionVersion: true },
    })).sessionVersion;
    const beforeTargetSV = (await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: targetUserId }, select: { sessionVersion: true },
    })).sessionVersion;

    const { id } = await nominateTransfer(ownerSession(), targetUserId);
    const res = await acceptTransfer(targetSession(), id);
    expect(res.ok).toBe(true);

    const org = await unsafePrismaAdmin.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.ownerUserId).toBe(targetUserId);

    const targetMembershipRefreshed = await unsafePrismaAdmin.membership.findUniqueOrThrow({
      where: { id: targetMembershipId },
      include: { roleRef: { select: { key: true } } },
    });
    expect(targetMembershipRefreshed.roleRef?.key).toBe('ORG_OWNER');

    const ownerMembershipRefreshed = await unsafePrismaAdmin.membership.findUniqueOrThrow({
      where: { id: ownerMembershipId },
      include: { roleRef: { select: { key: true } } },
    });
    expect(ownerMembershipRefreshed.roleRef?.key).toBe('ORG_ADMIN');

    const transferAfter = await unsafePrismaAdmin.ownershipTransfer.findUniqueOrThrow({ where: { id } });
    expect(transferAfter.status).toBe('accepted');

    // Both users' sessionVersions bumped — nominee gets +1 on nominate
    // AND +1 on accept; the ownerUserId gets +1 on accept.
    const afterOwnerSV = (await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: ownerUserId }, select: { sessionVersion: true },
    })).sessionVersion;
    const afterTargetSV = (await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: targetUserId }, select: { sessionVersion: true },
    })).sessionVersion;
    expect(afterOwnerSV).toBeGreaterThan(beforeOwnerSV);
    expect(afterTargetSV).toBeGreaterThan(beforeTargetSV);
  });

  it('decline closes the transfer without touching memberships', async () => {
    const { id } = await nominateTransfer(ownerSession(), targetUserId);
    await declineTransfer(targetSession(), id, 'not now');
    const t = await unsafePrismaAdmin.ownershipTransfer.findUniqueOrThrow({ where: { id } });
    expect(t.status).toBe('declined');
    expect(t.decidedReason).toBe('not now');
    const org = await unsafePrismaAdmin.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.ownerUserId).toBe(ownerUserId);
  });

  it('revoke closes the transfer (nominator only)', async () => {
    const { id } = await nominateTransfer(ownerSession(), targetUserId);
    await expect(revokeTransfer(targetSession(), id)).rejects.toBeInstanceOf(InvalidInputError);
    await revokeTransfer(ownerSession(), id);
    const t = await unsafePrismaAdmin.ownershipTransfer.findUniqueOrThrow({ where: { id } });
    expect(t.status).toBe('revoked');
  });

  it('accept refuses an expired pending row', async () => {
    // Create + backdate an expiry.
    const row = await unsafePrismaAdmin.ownershipTransfer.create({
      data: {
        organizationId: orgId,
        fromUserId: ownerUserId,
        toUserId: targetUserId,
        // Backdate 8 days.
        createdAt: new Date(Date.now() - 8 * 24 * 3600_000),
        expiresAt: new Date(Date.now() - 24 * 3600_000),
      },
    });
    await expect(acceptTransfer(targetSession(), row.id)).rejects.toBeInstanceOf(InvalidInputError);
    // And should be marked expired.
    const after = await unsafePrismaAdmin.ownershipTransfer.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('expired');
  });

  it('inbox lists pending transfers for the nominee', async () => {
    await nominateTransfer(ownerSession(), targetUserId);
    const inbox = await pendingTransfersForNominee(targetUserId);
    expect(inbox.length).toBe(1);
    expect(inbox[0].organizationName).toBe('Split Practice');
    expect(inbox[0].fromEmail).toBe('split-owner@bp.test');
  });
});
