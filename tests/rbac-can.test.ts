import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { prismaAdmin } from '@/lib/db';
import { can } from '@/lib/rbac/can';
import { buildAuthContext, __clearAuthContextCache } from '@/lib/rbac/context';
import { perm } from '@/lib/rbac/types';
import { __setRestrictedDuringImpersonation } from '@/lib/rbac/impersonation';
import { seedRbacFixtures } from '@/prisma/rbac-fixtures';

// -----------------------------------------------------------------------------
// Phase 3: can() correctness against the multi-tenant fixtures.
//
// This test is the crux of Phase 3 — every branch of spec §10 exercised
// against real DB-derived AuthContexts. If one of these fails, an existing
// route that we later migrate to requirePermission() in Phase 4 could be
// silently wrong.
// -----------------------------------------------------------------------------

async function ctxFor(email: string, orgName?: string) {
  const user = await prismaAdmin.appUser.findUniqueOrThrow({ where: { email } });
  const membership = orgName
    ? await prismaAdmin.membership.findFirstOrThrow({
        where: { userId: user.id, organization: { name: orgName } },
      })
    : await prismaAdmin.membership.findFirstOrThrow({ where: { userId: user.id } });
  const ctx = await buildAuthContext(user.id, membership.id);
  if (!ctx) throw new Error(`no ctx for ${email}`);
  return ctx;
}

describe('can()', () => {
  beforeAll(async () => {
    await seedRbacFixtures();
    __clearAuthContextCache();
  });

  afterEach(() => {
    __setRestrictedDuringImpersonation(new Set());
  });

  describe('scope resolution', () => {
    it('ORG_OWNER (:org grant) can update any booking in the org', async () => {
      const ctx = await ctxFor('split-owner@bp.test', 'Split Practice');
      expect(can(ctx, 'booking.update', {
        organizationId: ctx.activeOrganizationId!,
        branchId: 'anything',
      })).toBe(true);
    });

    it('PROVIDER (:own grant) can update their own booking', async () => {
      const ctx = await ctxFor('moonlight@bp.test', 'Split Practice');
      expect(can(ctx, 'booking.update', {
        organizationId: ctx.activeOrganizationId!,
        ownerUserId: ctx.userId,
      })).toBe(true);
    });

    it('PROVIDER cannot update someone else\'s booking', async () => {
      const ctx = await ctxFor('moonlight@bp.test', 'Split Practice');
      expect(can(ctx, 'booking.update', {
        organizationId: ctx.activeOrganizationId!,
        ownerUserId: '00000000-0000-0000-0000-000000000099',
      })).toBe(false);
    });

    it('BRANCH_MANAGER (:branch grant) can update bookings in scoped branches only', async () => {
      const ctx = await ctxFor('splitmgr@bp.test', 'Split Practice');
      const [downtown, airport] = await prismaAdmin.$queryRawUnsafe<Array<{ id: string; name: string }>>(
        `SELECT b.id, b.name FROM branches b JOIN organizations o ON o.id = b.organization_id
          WHERE o.name = 'Split Practice' AND b.name IN ('Downtown','Airport') ORDER BY b.name`,
      );
      // Wait — Airport lex < Downtown, so [0] is Airport. Rebind explicitly.
      const byName = Object.fromEntries((await prismaAdmin.branch.findMany({
        where: { organization: { name: 'Split Practice' } },
      })).map(b => [b.name, b.id]));
      expect(can(ctx, 'booking.update', {
        organizationId: ctx.activeOrganizationId!,
        branchId: byName.Downtown,
      })).toBe(true);
      expect(can(ctx, 'booking.update', {
        organizationId: ctx.activeOrganizationId!,
        branchId: byName.Airport,
      })).toBe(false);
      // Unused refs — TS strict on unused variables.
      void downtown; void airport;
    });
  });

  describe('tenant isolation', () => {
    it('a user in org A cannot touch a resource in org B', async () => {
      const ctx = await ctxFor('moonlight@bp.test', 'Grand Medical & Aurora Spa Group');
      const otherOrg = await prismaAdmin.organization.findFirstOrThrow({
        where: { name: 'Split Practice' },
      });
      expect(can(ctx, 'booking.read', {
        organizationId: otherOrg.id,
      })).toBe(false);
    });

    it('platform.* permissions ignore active org (no tenant check)', async () => {
      const ctx = await ctxFor('moonlight@bp.test', 'Grand Medical & Aurora Spa Group');
      // Moonlighter has no platform role → no platform permissions → deny.
      expect(can(ctx, 'platform.audit.read')).toBe(false);
    });
  });

  describe('fail-closed', () => {
    it('unknown permission key → false', async () => {
      const ctx = await ctxFor('split-owner@bp.test', 'Split Practice');
      expect(can(ctx, 'nonexistent.foo:org', {
        organizationId: ctx.activeOrganizationId!,
      })).toBe(false);
    });

    it('suspended organization → deny even with :org grant', async () => {
      const ctx = await ctxFor('split-owner@bp.test', 'Split Practice');
      const suspendedCtx = { ...ctx, organizationStatus: 'suspended' as const };
      expect(can(suspendedCtx, 'booking.update', {
        organizationId: ctx.activeOrganizationId!,
      })).toBe(false);
    });

    it('platform-only session (no membership) → org-plane permissions deny', async () => {
      // Craft a platform-only ctx by hand — no membership fixture for this yet.
      const ctx = {
        userId: 'u',
        email: 'p@a.dev',
        membershipId: null,
        activeOrganizationId: null,
        roleKey: null,
        roleRank: 0,
        permissions: new Set() as ReadonlySet<ReturnType<typeof perm>>,
        platformPermissions: new Set([perm('platform.org.suspend')]) as ReadonlySet<ReturnType<typeof perm>>,
        branchIds: new Set() as ReadonlySet<string>,
        impersonation: null,
        isImpersonating: false,
        breakGlass: null,
        isBreakGlass: false,
        sessionVersion: 1,
        organizationStatus: null,
        orgToggles: {
          providerFinancialReports: false,
          providerClinicalNotesOthers: false,
          frontdeskClientFullHistory: false,
          frontdeskDiscountCeiling: 0,
        },
      } as const;
      expect(can(ctx, 'booking.read', { organizationId: 'anything' })).toBe(false);
      expect(can(ctx, 'platform.org.suspend')).toBe(true);
    });
  });

  describe('impersonation restrictions', () => {
    it('restricted permission is denied when isImpersonating=true', async () => {
      const ctx = await ctxFor('split-owner@bp.test', 'Split Practice');
      // Restrictions are stated on the base action key (spec §7.1 — the
      // support agent is blocked from bulk export / billing changes as
      // actions, not from any specific scoped grant). can() checks the
      // incoming permission literally against the set, so populate it
      // with the same key that guards would call with.
      __setRestrictedDuringImpersonation(new Set([perm('booking.update')]));
      const impCtx = { ...ctx, isImpersonating: true };
      expect(can(impCtx, 'booking.update', {
        organizationId: ctx.activeOrganizationId!,
      })).toBe(false);
      // Not restricted while non-impersonating.
      expect(can(ctx, 'booking.update', {
        organizationId: ctx.activeOrganizationId!,
      })).toBe(true);
    });
  });
});
