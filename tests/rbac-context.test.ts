import { describe, it, expect, beforeAll } from 'vitest';
import { unsafePrismaAdmin } from '@/lib/db';
import { buildAuthContext, __clearAuthContextCache } from '@/lib/rbac/context';
import { seedRbacFixtures } from '@/prisma/rbac-fixtures';

// -----------------------------------------------------------------------------
// Phase 3: buildAuthContext resolution + cache semantics.
//
// Fail-closed cases go into rbac-can.test.ts (they need can() to observe the
// null / suspended shape). Here we focus on the shape of the built ctx.
// -----------------------------------------------------------------------------

describe('buildAuthContext', () => {
  let moonId: string;
  let grandMoonMemId: string;
  let splitMoonMemId: string;
  let splitMgrId: string;
  let splitMgrMemId: string;
  let downtown: string;
  let uptown: string;

  beforeAll(async () => {
    await seedRbacFixtures();

    const moon = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'moonlight@bp.test' },
    });
    moonId = moon.id;
    const moonMems = await unsafePrismaAdmin.membership.findMany({
      where: { userId: moon.id },
      include: { organization: { select: { name: true } } },
    });
    grandMoonMemId = moonMems.find((m) => m.organization.name.startsWith('Grand'))!.id;
    splitMoonMemId = moonMems.find((m) => m.organization.name === 'Split Practice')!.id;

    const mgr = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'splitmgr@bp.test' },
    });
    splitMgrId = mgr.id;
    const mgrMem = await unsafePrismaAdmin.membership.findFirstOrThrow({
      where: { userId: mgr.id },
    });
    splitMgrMemId = mgrMem.id;
    const branches = await unsafePrismaAdmin.branch.findMany({
      where: { organization: { name: 'Split Practice' } },
      orderBy: { name: 'asc' },
    });
    downtown = branches.find((b) => b.name === 'Downtown')!.id;
    uptown = branches.find((b) => b.name === 'Uptown')!.id;

    __clearAuthContextCache();
  });

  it('returns null for an unknown user', async () => {
    const ctx = await buildAuthContext('00000000-0000-0000-0000-000000000000', null);
    expect(ctx).toBeNull();
  });

  it('builds an org-plane context with the right role + permissions', async () => {
    const ctx = await buildAuthContext(moonId, grandMoonMemId);
    expect(ctx).not.toBeNull();
    expect(ctx!.roleKey).toBe('PROVIDER');
    expect(ctx!.membershipId).toBe(grandMoonMemId);
    expect(ctx!.branchIds.size).toBe(0); // PROVIDER has no branch scope
    expect(ctx!.permissions.size).toBeGreaterThan(0);
    expect(ctx!.platformPermissions.size).toBe(0); // moonlighter has no platform role
    expect(ctx!.isImpersonating).toBe(false);
  });

  it('populates branchIds for a scoped BRANCH_MANAGER', async () => {
    const ctx = await buildAuthContext(splitMgrId, splitMgrMemId);
    expect(ctx).not.toBeNull();
    expect(ctx!.roleKey).toBe('BRANCH_MANAGER');
    expect(new Set(ctx!.branchIds)).toEqual(new Set([downtown, uptown]));
  });

  it('same moonlighter user, different membership → different active org + role', async () => {
    __clearAuthContextCache();
    const grandCtx = await buildAuthContext(moonId, grandMoonMemId);
    const splitCtx = await buildAuthContext(moonId, splitMoonMemId);
    expect(grandCtx!.activeOrganizationId).not.toBe(splitCtx!.activeOrganizationId);
    // Both are PROVIDER — same role key, but distinct memberships.
    expect(grandCtx!.roleKey).toBe('PROVIDER');
    expect(splitCtx!.roleKey).toBe('PROVIDER');
    expect(grandCtx!.membershipId).not.toBe(splitCtx!.membershipId);
  });

  it('cache returns the same object for the same (membership, sessionVersion)', async () => {
    __clearAuthContextCache();
    const a = await buildAuthContext(moonId, grandMoonMemId);
    const b = await buildAuthContext(moonId, grandMoonMemId);
    expect(a).toBe(b); // reference-equal — cache hit
  });

  it('cache invalidates when sessionVersion changes', async () => {
    __clearAuthContextCache();
    const before = await buildAuthContext(moonId, grandMoonMemId);
    await unsafePrismaAdmin.appUser.update({
      where: { id: moonId },
      data: { sessionVersion: { increment: 1 } },
    });
    const after = await buildAuthContext(moonId, grandMoonMemId);
    expect(after).not.toBe(before);
    expect(after!.sessionVersion).toBe(before!.sessionVersion + 1);
  });
});
