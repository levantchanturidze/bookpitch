import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin } = await import('@/lib/db');
const { can } = await import('@/lib/rbac/can');
const { buildAuthContext, __clearAuthContextCache } = await import('@/lib/rbac/context');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');

// -----------------------------------------------------------------------------
// F16-012 — deployment ordering.
//
// A rollout is two steps: migration 63 removes MARKETING's client.read:contact
// row, and the new application code ships. Either can land first, and during any
// rollout window both states exist somewhere.
//
// Order A — migration first, then the app: the row is gone, and an old app
// simply reads a smaller bundle. Nothing to prove beyond "still works".
//
// Order B — the app first, while the old row is still present: this is the one
// that used to expose patient contact data, because the permission check reads
// role_permissions and the row said yes. ROLE_PERMISSION_DENIALS makes the
// answer no regardless.
//
// The old row is simulated on the real database and removed again, so the
// assertion is about the actual check, not a mock of it.
// -----------------------------------------------------------------------------

const PREFIX = 'E2E-PHASE16-ORDER';
let mktUserId: string;
let mktMembershipId: string;
let orgId: string;
let marketingRoleId: string;

async function setStaleRowPresent(present: boolean) {
  if (present) {
    await unsafePrismaAdmin.rolePermission.createMany({
      data: [{ roleId: marketingRoleId, permissionKey: 'client.read:contact' }],
      skipDuplicates: true,
    });
  } else {
    await unsafePrismaAdmin.rolePermission.deleteMany({
      where: { roleId: marketingRoleId, permissionKey: 'client.read:contact' },
    });
  }
  __clearAuthContextCache();
}

beforeAll(async () => {
  await seedRbacFixtures();
  __clearAuthContextCache();

  await unsafePrismaAdmin.appUser.updateMany({
    where: { email: { startsWith: `${PREFIX.toLowerCase()}-` } },
    data: { status: 'deleted' },
  });

  const owner = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'split-owner@bp.test' },
    select: { id: true },
  });
  const ownerMembership = await unsafePrismaAdmin.membership.findFirstOrThrow({
    where: { userId: owner.id, organization: { name: 'Split Practice' } },
    select: { organizationId: true },
  });
  orgId = ownerMembership.organizationId;

  const role = await unsafePrismaAdmin.role.findFirstOrThrow({
    where: { key: 'MARKETING', organizationId: null },
    select: { id: true },
  });
  marketingRoleId = role.id;

  const stamp = Date.now();
  const user = await unsafePrismaAdmin.appUser.create({
    data: {
      email: `${PREFIX.toLowerCase()}-${stamp}@bp.test`,
      status: 'active',
      authProvider: 'credentials',
      authSubject: `${PREFIX.toLowerCase()}-${stamp}`,
    },
    select: { id: true },
  });
  mktUserId = user.id;
  const membership = await unsafePrismaAdmin.membership.create({
    data: {
      userId: mktUserId,
      organizationId: orgId,
      roleId: marketingRoleId,
      role: 'receptionist',
      status: 'active',
    },
    select: { id: true },
  });
  mktMembershipId = membership.id;
});

afterAll(async () => {
  await setStaleRowPresent(false); // never leave the stale grant behind
  if (mktUserId || mktMembershipId) {
    await unsafePrismaAdmin.$transaction(async (tx) => {
      if (mktMembershipId) await tx.membership.deleteMany({ where: { id: mktMembershipId } });
      if (mktUserId) {
        await tx.appUser.updateMany({ where: { id: mktUserId }, data: { status: 'deleted' } });
        await tx.appUser.deleteMany({ where: { id: mktUserId } }).catch(() => undefined);
      }
    });
  }
  __clearAuthContextCache();
});

async function ctx() {
  __clearAuthContextCache();
  const c = await buildAuthContext(mktUserId, mktMembershipId);
  if (!c) throw new Error('no context');
  return c;
}

describe('F16-012 · both deployment orders are safe', () => {
  it('order B — new application, OLD database: contact access is still denied', async () => {
    await setStaleRowPresent(true);
    const c = await ctx();
    // The stale grant really is in the caller's bundle...
    expect(c.permissions.has('client.read:contact' as never)).toBe(true);
    // ...and the check refuses it anyway.
    expect(can(c, 'client.read:contact', { organizationId: orgId })).toBe(false);
    expect(can(c, 'client.read:full', { organizationId: orgId })).toBe(false);
    expect(can(c, 'client.export', { organizationId: orgId })).toBe(false);
  });

  it('order A — migration applied, row gone: denied for the ordinary reason too', async () => {
    await setStaleRowPresent(false);
    const c = await ctx();
    expect(c.permissions.has('client.read:contact' as never)).toBe(false);
    expect(can(c, 'client.read:contact', { organizationId: orgId })).toBe(false);
  });

  it('the aggregate reporting the role exists for survives both orders', async () => {
    for (const stale of [true, false]) {
      await setStaleRowPresent(stale);
      const c = await ctx();
      expect(can(c, 'report.branch', { organizationId: orgId }), `stale=${stale}`).toBe(true);
    }
  });

  it('the denial is scoped to MARKETING — clinical roles are unaffected', async () => {
    // Same check, a role that must keep the permission.
    const owner = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'split-owner@bp.test' },
      select: { id: true },
    });
    const m = await unsafePrismaAdmin.membership.findFirstOrThrow({
      where: { userId: owner.id, organizationId: orgId },
      select: { id: true },
    });
    __clearAuthContextCache();
    const ownerCtx = await buildAuthContext(owner.id, m.id);
    expect(can(ownerCtx!, 'client.read:contact', { organizationId: orgId })).toBe(true);
  });

  // Complement: without the code-level denial, order B is exactly the exposure
  // this exists to prevent. Demonstrated against the real bundle.
  it('without the denial layer, the stale row would have allowed it', async () => {
    const { isDeniedByRole } = await import('@/lib/rbac/role-denials');
    await setStaleRowPresent(true);
    const c = await ctx();
    // The bundle says yes; only the denial layer says no.
    expect(c.permissions.has('client.read:contact' as never)).toBe(true);
    expect(isDeniedByRole(c.roleKey, 'client.read:contact')).toBe(true);
    expect(isDeniedByRole('ORG_OWNER', 'client.read:contact')).toBe(false);
    await setStaleRowPresent(false);
  });
});
