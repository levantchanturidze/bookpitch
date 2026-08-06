import { describe, it, expect, beforeAll } from 'vitest';
import { unsafePrismaAdmin } from '@/lib/db';
import { seedRbacFixtures } from '@/prisma/rbac-fixtures';

// -----------------------------------------------------------------------------
// Phase 3 fixture invariants — shape asserted before the can()/context tests
// consume it. If this test fails, the more interesting tests are lying.
// -----------------------------------------------------------------------------

describe('RBAC Phase 3 fixtures', () => {
  beforeAll(async () => {
    await seedRbacFixtures();
  });

  it('creates Split Practice with 3 named branches (Downtown, Uptown, Airport)', async () => {
    const split = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' },
      include: { branches: { select: { name: true }, orderBy: { name: 'asc' } } },
    });
    // Fixture also seeds a legacy `locations` row for backwards-compat with
    // pages that still read locations; the Phase 2 sync trigger mirrors that
    // into an extra branch. Only assert on the three named-manually branches.
    const named = new Set(['Downtown', 'Uptown', 'Airport']);
    const filtered = split.branches
      .map((b) => b.name)
      .filter((n) => named.has(n))
      .sort();
    expect(filtered).toEqual(['Airport', 'Downtown', 'Uptown']);
  });

  it('Split Manager is scoped to exactly 2 branches (Downtown + Uptown)', async () => {
    const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'splitmgr@bp.test' },
    });
    const membership = await unsafePrismaAdmin.membership.findFirstOrThrow({
      where: { userId: user.id },
      include: {
        branches: { include: { branch: { select: { name: true } } } },
        roleRef: { select: { key: true } },
      },
    });
    expect(membership.roleRef?.key).toBe('BRANCH_MANAGER');
    const names = membership.branches.map((b) => b.branch.name).sort();
    expect(names).toEqual(['Downtown', 'Uptown']);
    expect(names).not.toContain('Airport');
  });

  it('Moonlighter has PROVIDER memberships in two orgs', async () => {
    const moon = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'moonlight@bp.test' },
    });
    const mems = await unsafePrismaAdmin.membership.findMany({
      where: { userId: moon.id },
      include: {
        organization: { select: { name: true } },
        roleRef: { select: { key: true } },
      },
    });
    expect(mems.length).toBe(2);
    for (const m of mems) {
      expect(m.roleRef?.key).toBe('PROVIDER');
    }
    const orgNames = mems.map((m) => m.organization.name).sort();
    expect(orgNames).toEqual(['Grand Medical & Aurora Spa Group', 'Split Practice']);
  });

  it('Solo Doc holds a membership in Solo Practice', async () => {
    const solo = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'solo@bp.test' },
    });
    const mems = await unsafePrismaAdmin.membership.findMany({
      where: { userId: solo.id },
      include: { organization: { select: { name: true } }, roleRef: { select: { key: true } } },
    });
    expect(mems.length).toBe(1);
    expect(mems[0].organization.name).toBe('Solo Practice');
    // MVP: solo doc's legacy enum is `owner` → role_id maps to ORG_OWNER
    // via the Phase 2 backfill / sync trigger. Second-hat (PROVIDER)
    // handling is a Phase 4 concern once the legacy unique is relaxed.
    expect(mems[0].roleRef?.key).toBe('ORG_OWNER');
  });

  it('is idempotent — a second run touches no new rows', async () => {
    const before = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT (SELECT count(*) FROM memberships)
            + (SELECT count(*) FROM organizations)
            + (SELECT count(*) FROM app_users)
            + (SELECT count(*) FROM branches)
            + (SELECT count(*) FROM membership_branches) AS n`,
    );
    await seedRbacFixtures();
    const after = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT (SELECT count(*) FROM memberships)
            + (SELECT count(*) FROM organizations)
            + (SELECT count(*) FROM app_users)
            + (SELECT count(*) FROM branches)
            + (SELECT count(*) FROM membership_branches) AS n`,
    );
    expect(after[0].n).toBe(before[0].n);
  });
});
