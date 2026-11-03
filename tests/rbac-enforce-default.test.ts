import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
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

const { isEnforcing, requirePermission, RBAC_MODULES, __resetEnforcementMode } =
  await import('@/lib/rbac/guard');
const { ForbiddenError } = await import('@/lib/auth');
const { log } = await import('@/lib/logger');

// -----------------------------------------------------------------------------
// The guard fails closed (CLAUDE.md invariant 2).
//
// Until 2026-11-03 an unset or empty RBAC_ENFORCE_MODULES meant shadow mode:
// requirePermission logged `rbac.shadow_deny` and let every denied request
// through. Production was safe only because Vercel set the variable to '*';
// tests/setup.ts forced '*' as well, so no unit test ever ran on the default,
// and once, locally, MARKETING reached /scheduler with the variable unset
// (e2e/journeys/forbidden-access.spec.ts). Any value that was not a module
// list the code knew — `"*"` with quotes, `SHADOW`, `all` — also shadowed
// everything, and shadow mode removed the only authorization the platform
// routes have, so any signed-in user could assign platform roles.
//
// Every refusal below is paired with a granted call that passes in the same
// configuration, so a guard that refused everything would fail too.
// -----------------------------------------------------------------------------

const ORG = '00000000-0000-0000-0000-000000000001';

function ctxWith(granted: string[], platformGranted: string[] = []): AuthContext {
  return {
    userId: 'u1',
    email: 'u1@bp.test',
    membershipId: 'm1',
    activeOrganizationId: ORG,
    roleKey: 'ORG_OWNER',
    roleRank: 100,
    permissions: new Set(granted.map(perm)) as ReadonlySet<PermissionKey>,
    platformPermissions: new Set(platformGranted.map(perm)) as ReadonlySet<PermissionKey>,
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
const assignPlatformRole = (ctx: AuthContext) =>
  requirePermission(ctx, 'platform.role.assign', undefined, 'platform');

const ORIGINAL = process.env.RBAC_ENFORCE_MODULES;
function setModules(value: string | undefined) {
  if (value === undefined) delete process.env.RBAC_ENFORCE_MODULES;
  else process.env.RBAC_ENFORCE_MODULES = value;
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const events = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((call: unknown[]) => call[0]);

beforeEach(() => {
  __resetEnforcementMode();
  warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  error = vi.spyOn(log, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  setModules(ORIGINAL);
  __resetEnforcementMode();
});

describe('RBAC_ENFORCE_MODULES fails closed', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['*', '*'],
    ['* padded', ' * '],
  ])('%s: every module enforces, and a denial throws and logs enforce_deny', (_l, value) => {
    setModules(value);
    for (const key of ['appointments', 'platform', null, 'not-a-module']) {
      expect(isEnforcing(key)).toBe(true);
    }
    expect(() => read(DENIED())).toThrow(ForbiddenError);
    expect(events(warn)).toEqual(['rbac.enforce_deny']);
    expect(events(error)).toEqual([]);
  });

  it.each([
    [','],
    [' , '],
    ['admin,'],
    ['*,admin'],
    ['admin,*'],
    ['"*"'],
    ["'*'"],
    ['all'],
    ['true'],
    ['1'],
    ['SHADOW'],
    ['Shadow'],
    ['Admin'],
    ['admin,ai'],
    ['appointments;billing'],
  ])('malformed %j: enforces every module and logs enforce_modules_invalid', (value) => {
    setModules(value);
    for (const key of ['appointments', 'billing', 'platform', null]) {
      expect(isEnforcing(key)).toBe(true);
    }
    expect(() => read(DENIED())).toThrow(ForbiddenError);
    expect(events(error)).toEqual(['rbac.enforce_modules_invalid']);
  });

  it('shadow lets an org-plane denial through, logs it, and reports the reduced mode once', () => {
    setModules('shadow');
    expect(isEnforcing('appointments')).toBe(false);
    const ctx = DENIED();
    expect(read(ctx)).toBe(ctx);
    expect(read(ctx)).toBe(ctx);
    expect(events(warn)).toEqual(['rbac.shadow_deny', 'rbac.shadow_deny']);
    expect(events(error)).toEqual(['rbac.enforcement_reduced']);
  });

  it('shadow never reaches the platform plane, an unnamed module or an unknown one', () => {
    setModules('shadow');
    expect(isEnforcing('platform')).toBe(true);
    expect(isEnforcing(null)).toBe(true);
    expect(isEnforcing('not-a-module')).toBe(true);
    expect(() => assignPlatformRole(DENIED())).toThrow(ForbiddenError);
    expect(() => read(DENIED(), null)).toThrow(ForbiddenError);
    expect(() => read(DENIED(), 'not-a-module')).toThrow(ForbiddenError);
  });

  it('a module list enforces what it names and shadows only the other known org-plane modules', () => {
    setModules(' admin , appointments ');
    expect(isEnforcing('appointments')).toBe(true);
    expect(isEnforcing('admin')).toBe(true);
    expect(isEnforcing('billing')).toBe(false);
    expect(isEnforcing('platform')).toBe(true);
    expect(isEnforcing(null)).toBe(true);
    expect(isEnforcing('not-a-module')).toBe(true);
    expect(() => read(DENIED(), 'appointments')).toThrow(ForbiddenError);
    expect(() => assignPlatformRole(DENIED())).toThrow(ForbiddenError);
    const ctx = DENIED();
    expect(read(ctx, 'billing')).toBe(ctx);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('rbac.enforcement_reduced', {
      mode: 'list',
      enforced: ['admin', 'appointments'],
    });
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['*', '*'],
    ['a list naming the module', 'appointments'],
    ['malformed', 'SHADOW'],
  ])(
    'COMPLEMENT (%s): a granted permission passes and nothing is logged as denied',
    (_l, value) => {
      setModules(value);
      const ctx = GRANTED();
      expect(read(ctx)).toBe(ctx);
      expect(events(warn)).toEqual([]);
    },
  );

  it('COMPLEMENT: under shadow, a holder of the platform permission is let through', () => {
    setModules('shadow');
    const ctx = ctxWith([], ['platform.role.assign']);
    expect(assignPlatformRole(ctx)).toBe(ctx);
    expect(events(warn)).toEqual([]);
  });
});

// Every module key a guarded caller passes must be one RBAC_MODULES knows, or a
// module list naming it would be refused as malformed. One-directional on
// purpose: a key that stops being used does not fail the build (DEF-53).
describe('RBAC_MODULES covers every call site', () => {
  const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'node_modules' && !name.startsWith('.')) sourceFiles(p, out);
      } else if (/\.tsx?$/.test(name)) {
        out.push(p);
      }
    }
    return out;
  }

  function moduleKeysAtCallSites(): Map<string, number> {
    const keys = new Map<string, number>();
    for (const dir of ['app', 'lib', 'components']) {
      for (const file of sourceFiles(path.join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/require(?:Page)?Permission\(/g)) {
          const open = (m.index ?? 0) + m[0].length - 1;
          let depth = 0;
          let close = -1;
          for (let i = open; i < Math.min(text.length, open + 2000); i++) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')' && --depth === 0) {
              close = i;
              break;
            }
          }
          if (close < 0) continue;
          const last = /(?:,|^)\s*'([a-z_]+)'\s*,?\s*$/.exec(text.slice(open + 1, close).trim());
          if (last) keys.set(last[1], (keys.get(last[1]) ?? 0) + 1);
        }
      }
    }
    return keys;
  }

  it('every literal module key at a call site is in RBAC_MODULES', () => {
    const keys = moduleKeysAtCallSites();
    // Guard against a scan that silently finds nothing.
    expect(keys.size).toBeGreaterThanOrEqual(10);
    expect(keys.get('platform') ?? 0).toBeGreaterThan(0);
    expect([...keys.keys()].filter((k) => !RBAC_MODULES.has(k))).toEqual([]);
  });
});
