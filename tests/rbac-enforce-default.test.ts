import { describe, it, expect, afterEach, vi } from 'vitest';
import { perm } from '@/lib/rbac/types';
import type { AuthContext, PermissionKey } from '@/lib/rbac/types';

// lib/rbac/guard.ts binds Auth.js's `auth()` at import time; mock it first, as
// tests/phase17-forbidden-boundary.test.ts does.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { isEnforcing, requirePermission } = await import('@/lib/rbac/guard');
const { ForbiddenError } = await import('@/lib/auth');

// -----------------------------------------------------------------------------
// The guard fails closed (CLAUDE.md invariant 2).
//
// Until 2026-11-03 an unset or empty RBAC_ENFORCE_MODULES meant shadow mode:
// requirePermission logged `rbac.shadow_deny` and let every denied request
// through. Production was safe only because Vercel set the variable to '*';
// tests/setup.ts forced '*' as well, so no unit test ever ran on the default,
// and once, locally, MARKETING reached /scheduler with the variable unset
// (e2e/journeys/forbidden-access.spec.ts). A dropped variable would have
// switched off every permission check in production with every check green.
//
// Each case below pairs the refusal with its complement: the same mode lets a
// granted permission through, so a guard that refused everything would fail.
// -----------------------------------------------------------------------------

const ORG = '00000000-0000-0000-0000-000000000001';

function ctxWith(granted: string[]): AuthContext {
  return {
    userId: 'u1',
    email: 'u1@bp.test',
    membershipId: 'm1',
    activeOrganizationId: ORG,
    roleKey: 'ORG_OWNER',
    roleRank: 100,
    permissions: new Set(granted.map(perm)) as ReadonlySet<PermissionKey>,
    platformPermissions: new Set() as ReadonlySet<PermissionKey>,
    branchIds: new Set() as ReadonlySet<string>,
    impersonation: null,
    isImpersonating: false,
    breakGlass: null,
    isBreakGlass: false,
    sessionVersion: 1,
    authSessionId: 's1',
    organizationStatus: 'active',
    orgToggles: {
      providerFinancialReports: false,
      providerClinicalNotesOthers: false,
      frontdeskClientFullHistory: false,
      frontdeskDiscountCeiling: 0,
    },
  };
}

const DENIED = () => ctxWith([]);
const GRANTED = () => ctxWith(['booking.read:org']);
const read = (ctx: AuthContext, module: string | null = 'appointments') =>
  requirePermission(ctx, 'booking.read', { organizationId: ORG }, module);

const ORIGINAL = process.env.RBAC_ENFORCE_MODULES;
function setModules(value: string | undefined) {
  if (value === undefined) delete process.env.RBAC_ENFORCE_MODULES;
  else process.env.RBAC_ENFORCE_MODULES = value;
}
afterEach(() => setModules(ORIGINAL));

describe('RBAC_ENFORCE_MODULES fails closed', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['*', '*'],
    ['* padded', ' * '],
  ])('%s: every module enforces, so a denial throws', (_label, value) => {
    setModules(value);
    expect(isEnforcing('appointments')).toBe(true);
    expect(isEnforcing(null)).toBe(true);
    expect(() => read(DENIED())).toThrow(ForbiddenError);
    expect(() => read(DENIED(), null)).toThrow(ForbiddenError);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['*', '*'],
    ['shadow', 'shadow'],
    ['a list naming the module', 'appointments'],
  ])('COMPLEMENT (%s): a granted permission passes', (_label, value) => {
    setModules(value);
    const ctx = GRANTED();
    expect(read(ctx)).toBe(ctx);
  });

  it('shadow mode only on explicit request: a denial is logged and let through', () => {
    setModules('shadow');
    expect(isEnforcing('appointments')).toBe(false);
    expect(isEnforcing(null)).toBe(false);
    const ctx = DENIED();
    expect(read(ctx)).toBe(ctx);
  });

  it('a module list enforces the modules it names and shadows the others', () => {
    setModules('admin, appointments');
    expect(isEnforcing('appointments')).toBe(true);
    expect(isEnforcing('admin')).toBe(true);
    expect(isEnforcing('billing')).toBe(false);
    expect(() => read(DENIED(), 'appointments')).toThrow(ForbiddenError);
    const ctx = DENIED();
    expect(read(ctx, 'billing')).toBe(ctx);
  });

  it('a module list cannot exempt a caller that names no module', () => {
    setModules('admin');
    expect(isEnforcing(null)).toBe(true);
    expect(isEnforcing(undefined)).toBe(true);
    expect(() => read(DENIED(), null)).toThrow(ForbiddenError);
  });
});
