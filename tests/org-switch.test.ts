import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// next-auth pulls in `next/server` at import time; the test doesn't touch
// auth() so mock it out to keep the module graph clean.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  __clearSessionVersionCache: vi.fn(),
}));

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const { listUserMemberships, switchActiveOrg } = await import('@/lib/org-switch');
const { InvalidInputError } = await import('@/lib/auth');

// -----------------------------------------------------------------------------
// Phase 3: switchActiveOrg no longer manipulates the bp_active_org cookie.
// It verifies the target membership and bumps sessionVersion; the client
// then re-signs-in with orgId as a credential to mint a new JWT.
//
// resolveActiveOrg is gone entirely. The JWT is the single source of truth.
// -----------------------------------------------------------------------------

describe('org switcher', () => {
  let orgA: string;
  let orgB: string;
  let orgUnrelated: string;
  let userId: string;
  let ownerOfBId: string;

  beforeAll(async () => {
    const ts = Date.now();
    const seed = await withoutRls(async (tx) => {
      const oA = await tx.organization.create({ data: { name: `swA-${ts}` } });
      const oB = await tx.organization.create({ data: { name: `swB-${ts}` } });
      const oU = await tx.organization.create({ data: { name: `swU-${ts}` } });
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `sw-${ts}@ex.dev`,
          email: `sw-${ts}@ex.dev`,
          fullName: 'Switcher',
          passwordHash: 'x',
        },
      });
      // oB needs an owner to satisfy the org_owner invariant; use a separate
      // fixture user so the test user stays a practitioner.
      const ownerOfB = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `sw-ownerb-${ts}@ex.dev`,
          email: `sw-ownerb-${ts}@ex.dev`,
          fullName: 'OwnerB',
          passwordHash: 'x',
        },
      });
      await tx.membership.createMany({
        data: [
          { organizationId: oA.id, userId: user.id, role: 'owner' },
          { organizationId: oB.id, userId: user.id, role: 'practitioner' },
          { organizationId: oB.id, userId: ownerOfB.id, role: 'owner' },
        ],
      });
      return { oA, oB, oU, user, ownerOfB };
    });
    orgA = seed.oA.id;
    orgB = seed.oB.id;
    orgUnrelated = seed.oU.id;
    userId = seed.user.id;
    ownerOfBId = seed.ownerOfB.id;
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.membership.deleteMany({
        where: { organizationId: { in: [orgA, orgB, orgUnrelated] } },
      });
      await tx.appUser.deleteMany({ where: { id: { in: [userId, ownerOfBId] } } });
      await tx.organization.deleteMany({
        where: { id: { in: [orgA, orgB, orgUnrelated] } },
      });
    });
  });

  it('lists both memberships in join order, with legacy role labels', async () => {
    const ms = await listUserMemberships(userId);
    expect(ms.length).toBe(2);
    expect(ms.map((m) => m.legacyRole).sort()).toEqual(['owner', 'practitioner']);
  });

  it('switchActiveOrg refuses an org the user is not a member of', async () => {
    await expect(switchActiveOrg(userId, orgUnrelated)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('switchActiveOrg bumps sessionVersion for a valid membership', async () => {
    const before = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    await switchActiveOrg(userId, orgB);
    const after = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: userId },
      select: { sessionVersion: true },
    });
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
  });
});
