import { describe, it, expect, beforeAll } from 'vitest';
import { unsafePrismaAdmin } from '@/lib/db';
import { canManageRoleAssignment } from '@/lib/rbac/rank';
import { buildAuthContext, __clearAuthContextCache } from '@/lib/rbac/context';
import { seedRbacFixtures } from '@/prisma/rbac-fixtures';

// -----------------------------------------------------------------------------
// Phase 3: canManageRoleAssignment — both guards (numeric rank + lattice)
// must hold. Peer roles (FRONT_DESK / PROVIDER at rank 40) fail the lattice
// even though they share a rank; escalation-above-own-rank fails the rank.
// -----------------------------------------------------------------------------

async function ctxFor(email: string, orgName?: string) {
  const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({ where: { email } });
  const membership = orgName
    ? await unsafePrismaAdmin.membership.findFirstOrThrow({
        where: { userId: user.id, organization: { name: orgName } },
      })
    : await unsafePrismaAdmin.membership.findFirstOrThrow({ where: { userId: user.id } });
  const ctx = await buildAuthContext(user.id, membership.id);
  if (!ctx) throw new Error(`no ctx for ${email}`);
  return ctx;
}

describe('canManageRoleAssignment', () => {
  beforeAll(async () => {
    await seedRbacFixtures();
    __clearAuthContextCache();
  });

  it('ORG_OWNER can manage every org-plane role', async () => {
    const owner = await ctxFor('split-owner@bp.test', 'Split Practice');
    for (const target of [
      'ORG_ADMIN',
      'BRANCH_MANAGER',
      'FRONT_DESK',
      'PROVIDER',
      'SENIOR_PROVIDER',
      'ACCOUNTANT',
      'MARKETING',
    ]) {
      expect(await canManageRoleAssignment(owner, target)).toBe(true);
    }
  });

  it('ORG_OWNER cannot self-promote to SUPER_ADMIN (rank ceiling)', async () => {
    const owner = await ctxFor('split-owner@bp.test', 'Split Practice');
    expect(await canManageRoleAssignment(owner, 'SUPER_ADMIN')).toBe(false);
  });

  it('BRANCH_MANAGER can manage FRONT_DESK and PROVIDER only', async () => {
    const mgr = await ctxFor('splitmgr@bp.test', 'Split Practice');
    expect(await canManageRoleAssignment(mgr, 'FRONT_DESK')).toBe(true);
    expect(await canManageRoleAssignment(mgr, 'PROVIDER')).toBe(true);
    expect(await canManageRoleAssignment(mgr, 'ORG_ADMIN')).toBe(false);
    expect(await canManageRoleAssignment(mgr, 'ORG_OWNER')).toBe(false);
  });

  it('PROVIDER cannot manage its FRONT_DESK peer (same rank, no lattice edge)', async () => {
    const provider = await ctxFor('moonlight@bp.test', 'Split Practice');
    expect(await canManageRoleAssignment(provider, 'FRONT_DESK')).toBe(false);
    // And obviously can't manage itself either.
    expect(await canManageRoleAssignment(provider, 'PROVIDER')).toBe(false);
  });
});
