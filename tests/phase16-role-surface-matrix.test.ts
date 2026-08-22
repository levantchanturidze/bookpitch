import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { AuthContext, PermissionKey } from '@/lib/rbac/types';
import { NAV_ITEMS } from '@/components/shell/nav-items';

// lib/rbac re-exports reach @/auth; stub as the other RBAC tests do.
vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin } = await import('@/lib/db');
const { can } = await import('@/lib/rbac/can');
const { DEFAULT_TOGGLES } = await import('@/lib/rbac/toggles');

// -----------------------------------------------------------------------------
// F16-007. Role-by-surface evidence for all 13 authoritative roles.
//
// tests/route-access.test.ts exercises a handful of fixture users against the
// nav items. That is a spot check, not coverage: it says nothing about the nine
// roles it does not instantiate, and a general RBAC suite passing is not
// evidence that MARKETING cannot reach the audit log.
//
// This builds a real AuthContext per role from the authoritative role_permissions
// rows and evaluates the real can(), so the table below is measured rather than
// asserted. Roles live in three planes and the plane decides which context is
// even coherent: platform roles hold no membership, so the app plane is closed
// to them by construction, and CLIENT holds no permissions at all.
// -----------------------------------------------------------------------------

const ORG = '00000000-0000-4000-8000-0000000000aa';

type RoleRow = { key: string; rank: number; plane: string; perms: string[] };

let roles: RoleRow[] = [];

function contextFor(role: RoleRow, toggles = DEFAULT_TOGGLES): AuthContext {
  const keys = new Set(role.perms.map((p) => p as PermissionKey));
  const isPlatform = role.plane === 'platform';
  return {
    userId: '00000000-0000-4000-8000-0000000000bb',
    email: `${role.key.toLowerCase()}@matrix.test`,
    membershipId: isPlatform ? null : 'm-1',
    activeOrganizationId: isPlatform ? null : ORG,
    roleKey: isPlatform ? null : role.key,
    roleRank: role.rank,
    permissions: isPlatform ? new Set<PermissionKey>() : keys,
    platformPermissions: isPlatform ? keys : new Set<PermissionKey>(),
    branchIds: new Set<string>(),
    orgToggles: toggles,
    impersonation: null,
    isImpersonating: false,
    breakGlass: null,
  } as unknown as AuthContext;
}

beforeAll(async () => {
  const rows = await unsafePrismaAdmin.role.findMany({
    where: { organizationId: null },
    select: {
      key: true,
      rank: true,
      plane: true,
      permissions: { select: { permissionKey: true } },
    },
    orderBy: { rank: 'desc' },
  });
  roles = rows.map((r) => ({
    key: r.key,
    rank: r.rank,
    plane: String(r.plane),
    perms: r.permissions.map((rp) => rp.permissionKey),
  }));
});

describe('F16-007 · role × surface matrix', () => {
  it('covers exactly the 13 authoritative roles', () => {
    expect(roles).toHaveLength(13);
    expect(roles.filter((r) => r.plane === 'platform')).toHaveLength(4);
    expect(roles.filter((r) => r.plane === 'organization')).toHaveLength(8);
    expect(roles.filter((r) => r.plane === 'consumer')).toHaveLength(1);
  });

  it('prints the measured matrix and evaluates every cell', () => {
    const header = ['role'.padEnd(16), ...NAV_ITEMS.map((n) => n.id.slice(0, 9).padEnd(10))].join('');
    const lines = [header, '-'.repeat(header.length)];
    let cells = 0;

    for (const role of roles) {
      const ctx = contextFor(role);
      const row = [role.key.padEnd(16)];
      for (const item of NAV_ITEMS) {
        const allowed = can(ctx, item.requiredPermission, { organizationId: ORG });
        row.push((allowed ? 'ALLOW' : 'deny').padEnd(10));
        cells++;
      }
      lines.push(row.join(''));
    }
    console.log('\n' + lines.join('\n'));
    expect(cells).toBe(13 * NAV_ITEMS.length);
  });

  // --- invariants the matrix must satisfy -----------------------------------

  it('CLIENT reaches no app-plane surface', () => {
    const client = roles.find((r) => r.key === 'CLIENT')!;
    expect(client.perms).toHaveLength(0);
    const ctx = contextFor(client);
    for (const item of NAV_ITEMS) {
      expect(can(ctx, item.requiredPermission, { organizationId: ORG }), item.id).toBe(false);
    }
  });

  it('platform-plane roles reach no app-plane surface — they hold no membership', () => {
    for (const role of roles.filter((r) => r.plane === 'platform')) {
      const ctx = contextFor(role);
      for (const item of NAV_ITEMS) {
        expect(
          can(ctx, item.requiredPermission, { organizationId: ORG }),
          `${role.key} → ${item.id}`,
        ).toBe(false);
      }
    }
  });

  it('settings is reachable only by the two administrative org roles', () => {
    const settings = NAV_ITEMS.find((n) => n.id === 'settings')!;
    const allowed = roles
      .filter((r) => r.plane === 'organization')
      .filter((r) => can(contextFor(r), settings.requiredPermission, { organizationId: ORG }))
      .map((r) => r.key);
    // Measured, not assumed: ORG_ADMIN holds org.settings.update:org too, which
    // is the point of the role. Everything at BRANCH_MANAGER rank and below is
    // shut out.
    expect(allowed).toEqual(['ORG_OWNER', 'ORG_ADMIN']);
  });

  it('every ALLOW is justified by a permission the role actually holds', () => {
    // Guards against can() granting on something other than the role bundle —
    // the failure mode where a surface opens for a reason nobody intended.
    for (const role of roles.filter((r) => r.plane === 'organization')) {
      const ctx = contextFor(role);
      for (const item of NAV_ITEMS) {
        if (!can(ctx, item.requiredPermission, { organizationId: ORG })) continue;
        const base = String(item.requiredPermission).split(':')[0];
        const justified = role.perms.some((p) => p === item.requiredPermission || p.startsWith(`${base}:`));
        expect(justified, `${role.key} allowed ${item.id} with no matching grant`).toBe(true);
      }
    }
  });

  it('a role with no grants is denied even when the org context is valid', () => {
    // Fail-closed complement: same context shape, empty bundle.
    const empty = contextFor({ key: 'EMPTY', rank: 10, plane: 'organization', perms: [] });
    for (const item of NAV_ITEMS) {
      expect(can(empty, item.requiredPermission, { organizationId: ORG })).toBe(false);
    }
  });

  it('cross-tenant: a valid role is denied against a different organization', () => {
    const owner = roles.find((r) => r.key === 'ORG_OWNER')!;
    const ctx = contextFor(owner);
    const other = '00000000-0000-4000-8000-0000000000ff';
    for (const item of NAV_ITEMS) {
      expect(can(ctx, item.requiredPermission, { organizationId: other }), item.id).toBe(false);
    }
  });

  it('an org toggle changes the matrix, and flipping it back changes it again', () => {
    // CLAUDE.md: a control that does not change observable behaviour does not
    // exist. providerFinancialReports is the one toggle that opens an app-plane
    // surface, so assert both directions rather than only the grant.
    const provider = roles.find((r) => r.key === 'PROVIDER')!;
    const analytics = NAV_ITEMS.find((n) => n.id === 'analytics')!;

    const off = can(contextFor(provider), analytics.requiredPermission, { organizationId: ORG });
    const on = can(
      contextFor(provider, { ...DEFAULT_TOGGLES, providerFinancialReports: true }),
      analytics.requiredPermission,
      { organizationId: ORG },
    );

    expect(off).toBe(false);
    expect(on).toBe(true);
  });
});
