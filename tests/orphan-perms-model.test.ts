import { describe, it, expect } from 'vitest';
import { can } from '@/lib/rbac/can';
import { perm, type AuthContext, type PermissionKey } from '@/lib/rbac/types';
import {
  isEnforced,
  classify,
  scanEnforcement,
  scanSeed,
  SCOPE_SUFFIXES,
  TIER_SUFFIXES,
  type SeededPermission,
} from '@/scripts/check-orphan-perms';

// -----------------------------------------------------------------------------
// P17-006 — the orphan-permission checker makes two claims about the codebase,
// and both are the kind of claim that rots silently.
//
//   1. "This scope/tier key is reachable from that callsite."  — a claim about
//      how can() resolves keys. If can() changes, the checker starts reporting
//      fiction and CI keeps passing.
//
//   2. "A reference from a deny list / comment / metadata table is not
//      enforcement."  — the defect this whole rework exists to fix. The old
//      checker counted five permissions as enforced purely because
//      RESTRICTED_DURING_IMPERSONATION named them.
//
// Both are pinned here against the real thing: claim 1 against can() itself,
// claim 2 against a scan of the actual source tree. Each has a complement
// assertion — a case that must FAIL classification — so neither can pass by
// returning nothing.
// -----------------------------------------------------------------------------

function ctxWith(granted: string[]): AuthContext {
  return {
    userId: 'u1',
    email: 'u1@bp.test',
    membershipId: 'm1',
    activeOrganizationId: '00000000-0000-0000-0000-000000000001',
    roleKey: 'ORG_ADMIN',
    roleRank: 80,
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

describe('checker model matches can() — scope suffixes resolve from the base', () => {
  for (const suffix of SCOPE_SUFFIXES) {
    if (suffix === 'platform') continue; // platform.* short-circuits before scope resolution
    it(`can() reaches a :${suffix} grant from the base key, and the model agrees`, () => {
      const ctx = ctxWith([`booking.read:${suffix}`]);
      // Behaviour: can() resolves the scoped grant when handed the base key.
      expect(can(ctx, 'booking.read')).toBe(true);
      // Model: the checker counts the seeded scoped key as enforced by a base callsite.
      expect(isEnforced(`booking.read:${suffix}`, new Set(['booking.read']))).toBe(true);
    });
  }

  it('platform.* is decided by the platform set, not by scope resolution', () => {
    const ctx = ctxWith([]);
    const withPlatform: AuthContext = {
      ...ctx,
      platformPermissions: new Set([perm('platform.org.suspend')]) as ReadonlySet<PermissionKey>,
    };
    expect(can(withPlatform, 'platform.org.suspend')).toBe(true);
    expect(can(withPlatform, 'platform.org.delete')).toBe(false);
  });
});

describe('checker model matches can() — tier suffixes are exact-match only', () => {
  for (const tier of TIER_SUFFIXES) {
    it(`a :${tier} grant is NOT reachable from the base key`, () => {
      const ctx = ctxWith([`client.read:${tier}`]);
      // Behaviour: can() falls through to exact match, so the base denies.
      expect(can(ctx, 'client.read')).toBe(false);
      // Model: the checker does not count it as enforced by a base callsite.
      expect(isEnforced(`client.read:${tier}`, new Set(['client.read']))).toBe(false);
    });
  }

  it('one tier does not satisfy a callsite asking for another', () => {
    const ctx = ctxWith(['client.read:basic']);
    expect(can(ctx, 'client.read:contact')).toBe(false);
    expect(can(ctx, 'client.read:full')).toBe(false);
    expect(isEnforced('client.read:basic', new Set(['client.read:contact']))).toBe(false);
  });

  it('an exact tier grant does satisfy that exact callsite — the complement', () => {
    const ctx = ctxWith(['client.read:contact']);
    expect(can(ctx, 'client.read:contact')).toBe(true);
    expect(isEnforced('client.read:contact', new Set(['client.read:contact']))).toBe(true);
  });
});

describe('a deny-list reference is not an enforcement reference', () => {
  const references = scanEnforcement();

  it('org.delete appears ONLY in RESTRICTED_DURING_IMPERSONATION and is not counted', () => {
    // lib/rbac/impersonation.ts contains `perm('org.delete')`. The old regex
    // checker counted that as enforcement; nothing in the app ever asks
    // whether the caller holds org.delete.
    expect(references.has('org.delete')).toBe(false);
  });

  it.each(['clinical_note.create', 'clinical_note.attachment.manage', 'platform.billing.manage'])(
    '%s is deny-listed but never asked for',
    (key) => {
      expect(references.has(key)).toBe(false);
    },
  );

  it('nothing in lib/rbac/impersonation.ts is attributed as enforcement', () => {
    const fromDenyList = [...references.values()]
      .flat()
      .filter((r) => r.file.endsWith('impersonation.ts'));
    expect(fromDenyList).toEqual([]);
  });

  it('COMPLEMENT: a key with a real gate IS counted, so the scan is not vacuous', () => {
    // app/api/health/ready/route.ts returns 403 unless
    // ctx.platformPermissions.has(perm('platform.config.manage')).
    const refs = references.get('platform.config.manage') ?? [];
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((r) => r.file.includes('health/ready'))).toBe(true);
  });
});

describe('a comment is not an enforcement reference', () => {
  const references = scanEnforcement();

  it('the usage docstring in lib/rbac/guard.ts is not a callsite', () => {
    // guard.ts documents itself as `requirePermission(ctx, 'booking.update', …)`
    // inside a block comment. The AST never sees it.
    const fromGuard = [...references.values()].flat().filter((r) => r.file.endsWith('guard.ts'));
    expect(fromGuard).toEqual([]);
  });

  it('the JSDoc keys in lib/rbac/toggles.ts are not callsites', () => {
    const fromToggles = [...references.values()]
      .flat()
      .filter((r) => r.file.endsWith('toggles.ts'));
    expect(fromToggles).toEqual([]);
  });

  it('the grant/elevation table in can() is not enforcement', () => {
    // `p === perm('report.branch')` inside toggleGrantsPermission GRANTS the
    // permission; it never refuses anyone. report.branch is enforced at
    // /analytics, so assert on the file rather than on the key.
    const fromCan = [...references.values()].flat().filter((r) => r.file.endsWith('rbac/can.ts'));
    expect(fromCan).toEqual([]);
  });
});

describe('the AST scan finds callsites the old regex missed', () => {
  const references = scanEnforcement();

  it('can(v.ctx, …) with a property-access receiver is a callsite', () => {
    // lib/customers.ts::decideFullAccess is the single enforcement point for
    // the clinical tier. The old regex required a bare identifier as the first
    // argument, so `can(v.ctx, 'clinical_note.read:any', …)` was invisible and
    // the key looked deny-list-only.
    const refs = references.get('clinical_note.read:any') ?? [];
    expect(refs.some((r) => r.file.endsWith('lib/customers.ts'))).toBe(true);
  });
});

describe('classification policy actually bites', () => {
  const enforcedKeys = new Set(scanEnforcement().keys());

  it('the repository currently has no orphan or inconsistent permission', () => {
    const buckets = classify(scanSeed(), enforcedKeys);
    expect(buckets.ORPHAN).toEqual([]);
    expect(buckets.INCONSISTENT).toEqual([]);
    // Not a tautology: the enforced bucket must be non-trivial for the above
    // to mean anything.
    expect(buckets.ENFORCED.length).toBeGreaterThan(30);
  });

  it('COMPLEMENT: an untagged permission with no callsite is ORPHAN', () => {
    const fixture: SeededPermission[] = [{ key: 'ghost.feature', notYetImplemented: null }];
    const buckets = classify(fixture, enforcedKeys);
    expect(buckets.ORPHAN.map((e) => e.key)).toEqual(['ghost.feature']);
  });

  it('COMPLEMENT: a tagged permission that IS enforced is INCONSISTENT', () => {
    const fixture: SeededPermission[] = [{ key: 'audit.read', notYetImplemented: 'some_bundle' }];
    const buckets = classify(fixture, enforcedKeys);
    expect(buckets.INCONSISTENT.map((e) => e.key)).toEqual(['audit.read']);
  });

  it('COMPLEMENT: a tagged permission with no callsite is EXPLICITLY_DEFERRED', () => {
    const fixture: SeededPermission[] = [{ key: 'ghost.feature', notYetImplemented: 'ghosts' }];
    const buckets = classify(fixture, enforcedKeys);
    expect(buckets.EXPLICITLY_DEFERRED.map((e) => e.key)).toEqual(['ghost.feature']);
  });
});
