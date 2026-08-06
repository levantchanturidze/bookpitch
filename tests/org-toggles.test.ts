import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { unsafePrismaAdmin } = await import('@/lib/db');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { can, updateOrgToggles, loadOrgToggles, buildAuthContext, DEFAULT_TOGGLES } =
  await import('@/lib/rbac');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { __clearOrgTogglesCache } = await import('@/lib/rbac/toggles');
const { assertDiscountWithinCeiling } = await import('@/lib/payments/service');
const { InvalidInputError } = await import('@/lib/auth');

// -----------------------------------------------------------------------------
// Phase 6 spec §6.2 ⚙️ toggles. Verifies:
//   • Toggles change what can() returns for the gated (role, key) pairs.
//   • Toggles round-trip through the JSONB storage.
//   • The discount ceiling helper enforces the threshold for FRONT_DESK.
// -----------------------------------------------------------------------------

describe('per-org policy toggles', () => {
  let splitOrgId: string;
  let moonMembershipId: string;
  let mgrMembershipId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    splitOrgId = (
      await unsafePrismaAdmin.organization.findFirstOrThrow({
        where: { name: 'Split Practice' },
        select: { id: true },
      })
    ).id;
    const moon = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'moonlight@bp.test' },
    });
    moonMembershipId = (
      await unsafePrismaAdmin.membership.findFirstOrThrow({
        where: { userId: moon.id, organizationId: splitOrgId },
      })
    ).id;
    const mgr = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'splitmgr@bp.test' },
    });
    mgrMembershipId = (
      await unsafePrismaAdmin.membership.findFirstOrThrow({
        where: { userId: mgr.id, organizationId: splitOrgId },
      })
    ).id;
  });

  beforeEach(() => {
    __clearAuthContextCache();
    __clearOrgTogglesCache();
  });

  afterAll(async () => {
    // Restore defaults so other test files don't inherit our flips.
    await updateOrgToggles(splitOrgId, DEFAULT_TOGGLES);
  });

  it('defaults are safe (all restrictive)', async () => {
    await updateOrgToggles(splitOrgId, DEFAULT_TOGGLES);
    const toggles = await loadOrgToggles(splitOrgId);
    expect(toggles.providerFinancialReports).toBe(false);
    expect(toggles.providerClinicalNotesOthers).toBe(false);
    expect(toggles.frontdeskClientFullHistory).toBe(false);
    expect(toggles.frontdeskDiscountCeiling).toBe(0);
  });

  it('PROVIDER cannot read others clinical notes when toggle is OFF', async () => {
    await updateOrgToggles(splitOrgId, { providerClinicalNotesOthers: false });
    __clearAuthContextCache();
    const moon = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'moonlight@bp.test' },
    });
    const ctx = await buildAuthContext(moon.id, moonMembershipId);
    expect(ctx).not.toBeNull();
    expect(can(ctx!, 'clinical_note.read:any', { organizationId: splitOrgId })).toBe(false);
  });

  it('PROVIDER can read others clinical notes when toggle is ON', async () => {
    await updateOrgToggles(splitOrgId, { providerClinicalNotesOthers: true });
    // Also seed the perm on the role — PROVIDER's default seed does NOT
    // include clinical_note.read:any (spec §6.2 ⚙️ off), so we need to
    // temporarily add it for the test. Alternatively: pick a role that
    // DOES have :any and toggle-gated. Since only PROVIDER is toggled
    // in our seed, grant it here.
    const providerRole = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'PROVIDER', organizationId: null },
    });
    const existing = await unsafePrismaAdmin.rolePermission.findFirst({
      where: { roleId: providerRole.id, permissionKey: 'clinical_note.read:any' },
    });
    if (!existing) {
      await unsafePrismaAdmin.rolePermission.create({
        data: { roleId: providerRole.id, permissionKey: 'clinical_note.read:any' },
      });
    }

    __clearAuthContextCache();
    const moon = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'moonlight@bp.test' },
    });
    const ctx = await buildAuthContext(moon.id, moonMembershipId);
    expect(can(ctx!, 'clinical_note.read:any', { organizationId: splitOrgId })).toBe(true);

    // Cleanup: remove the temp grant so the seed converges again on next run.
    if (!existing) {
      await unsafePrismaAdmin.rolePermission.delete({
        where: {
          roleId_permissionKey: {
            roleId: providerRole.id,
            permissionKey: 'clinical_note.read:any',
          },
        },
      });
    }
  });

  it('FRONT_DESK cannot read client:full when toggle is OFF', async () => {
    // splitmgr is BRANCH_MANAGER; we need a FRONT_DESK. Temp-flip mgr to
    // FRONT_DESK for this test.
    const fdRole = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'FRONT_DESK', organizationId: null },
    });
    await unsafePrismaAdmin.membership.update({
      where: { id: mgrMembershipId },
      data: { roleId: fdRole.id },
    });
    await updateOrgToggles(splitOrgId, { frontdeskClientFullHistory: false });
    __clearAuthContextCache();
    const mgr = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'splitmgr@bp.test' },
    });
    const ctx = await buildAuthContext(mgr.id, mgrMembershipId);
    expect(ctx!.roleKey).toBe('FRONT_DESK');
    expect(can(ctx!, 'client.read:full', { organizationId: splitOrgId })).toBe(false);
    // Contact tier remains available.
    expect(can(ctx!, 'client.read:contact', { organizationId: splitOrgId })).toBe(true);

    // Restore BRANCH_MANAGER.
    const bmRole = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'BRANCH_MANAGER', organizationId: null },
    });
    await unsafePrismaAdmin.membership.update({
      where: { id: mgrMembershipId },
      data: { roleId: bmRole.id },
    });
  });

  it('discount ceiling helper: no-op when actor is not FRONT_DESK', async () => {
    // ORG_OWNER can apply any discount — the helper skips the check.
    await expect(
      assertDiscountWithinCeiling(splitOrgId, 'ORG_OWNER', 1_000_000),
    ).resolves.toBeUndefined();
  });

  it('discount ceiling helper: rejects amounts above ceiling for FRONT_DESK', async () => {
    await updateOrgToggles(splitOrgId, { frontdeskDiscountCeiling: 10 });
    await expect(assertDiscountWithinCeiling(splitOrgId, 'FRONT_DESK', 25)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(
      assertDiscountWithinCeiling(splitOrgId, 'FRONT_DESK', 10),
    ).resolves.toBeUndefined();
    await expect(assertDiscountWithinCeiling(splitOrgId, 'FRONT_DESK', 5)).resolves.toBeUndefined();
  });
});
