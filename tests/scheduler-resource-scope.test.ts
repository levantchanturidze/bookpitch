import { describe, it, expect } from 'vitest';
import { can } from '@/lib/rbac/can';
import { perm } from '@/lib/rbac/types';
import type { AuthContext, PermissionKey } from '@/lib/rbac/types';
import { appointmentResource } from '@/lib/rbac/scope';

// -----------------------------------------------------------------------------
// 5.2 — the scheduler authorised the ACTION but never the RESOURCE.
//
// `can()` deliberately grants `:own` and `:branch` when the caller passes no
// `ownerUserId` / `branchId`. That fallback is correct and load-bearing: it is
// LIST mode, where the permission layer trusts the query layer to filter (see
// the comment at can.ts 4b/4c, and scopedByOwn/scopedLocationIds).
//
// components/scheduler/actions.ts called:
//
//     requirePermission(ctx, 'booking.update',
//                       { organizationId: ctx.activeOrganizationId! },
//                       'appointments')
//
// on a MUTATION of one concrete appointment, with no owner and no branch — so
// every `:own` and `:branch` caller took the list-mode path and was allowed to
// update ANY appointment in the organisation, including another provider's, by
// passing its id. Tenant isolation still held; scope inside the tenant did not.
//
// The appointment was loaded AFTER the check, so the facts needed to authorise
// it were already available one line later. Nothing about it was hard.
//
// These tests pin the resource shape the action must build. They are written
// against can() directly, because that is the decision the action delegates to;
// the Server Action and API paths are exercised in
// tests/scheduler-actions-authz.test.ts.
// -----------------------------------------------------------------------------

const ORG = '00000000-0000-0000-0000-0000000000aa';
const OTHER_ORG = '00000000-0000-0000-0000-0000000000bb';
const BRANCH_A = '00000000-0000-0000-0000-0000000000c1';
const BRANCH_B = '00000000-0000-0000-0000-0000000000c2';
const ME = 'user-me';
const SOMEONE_ELSE = 'user-other';

function ctx(granted: string[], over: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: ME,
    email: 'me@bp.test',
    membershipId: 'm1',
    activeOrganizationId: ORG,
    roleKey: 'PROVIDER',
    roleRank: 40,
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
    ...over,
  } as AuthContext;
}

/** What the action must pass. Shape-only; the action supplies the real row. */
const resourceFor = (opts: { ownerUserId?: string | null; locationId?: string | null }) =>
  appointmentResource(ORG, opts);

describe('appointmentResource — the shape the scheduler must authorise against', () => {
  it('carries organisation, branch and owner', () => {
    const r = resourceFor({ ownerUserId: ME, locationId: BRANCH_A });
    expect(r.organizationId).toBe(ORG);
    expect(r.branchId).toBe(BRANCH_A);
    expect(r.ownerUserId).toBe(ME);
  });

  it('omits owner when the appointment has no linked user, rather than inventing one', () => {
    // Staff.userId is nullable. Coercing null to a string would make the
    // comparison `'' === ctx.userId` — false for everyone — which silently
    // denies rather than falling back to the branch check.
    const r = resourceFor({ ownerUserId: null, locationId: BRANCH_A });
    expect('ownerUserId' in r ? r.ownerUserId : undefined).toBeUndefined();
    expect(r.branchId).toBe(BRANCH_A);
  });
});

describe(':own scope on a concrete appointment', () => {
  const provider = () => ctx(['booking.update:own']);

  it("DENIES updating another provider's appointment", () => {
    // THE DEFECT. Before the fix the action passed no ownerUserId, can() took
    // the list-mode fallback, and this returned true.
    expect(
      can(
        provider(),
        'booking.update',
        resourceFor({ ownerUserId: SOMEONE_ELSE, locationId: BRANCH_A }),
      ),
    ).toBe(false);
  });

  it('ALLOWS updating their own appointment', () => {
    expect(
      can(provider(), 'booking.update', resourceFor({ ownerUserId: ME, locationId: BRANCH_A })),
    ).toBe(true);
  });

  it('still permits LIST mode, where no concrete resource exists', () => {
    // The complement that stops the fix from over-correcting: removing the
    // fallback entirely would leave a :own role unable to list anything.
    expect(can(provider(), 'booking.update', { organizationId: ORG })).toBe(true);
  });
});

describe(':branch scope on a concrete appointment', () => {
  const branchStaff = () =>
    ctx(['booking.update:branch'], { branchIds: new Set([BRANCH_A]) as ReadonlySet<string> });

  it('DENIES updating an appointment in a branch the caller does not hold', () => {
    expect(
      can(
        branchStaff(),
        'booking.update',
        resourceFor({ ownerUserId: SOMEONE_ELSE, locationId: BRANCH_B }),
      ),
    ).toBe(false);
  });

  it('ALLOWS updating an appointment in an assigned branch', () => {
    expect(
      can(
        branchStaff(),
        'booking.update',
        resourceFor({ ownerUserId: SOMEONE_ELSE, locationId: BRANCH_A }),
      ),
    ).toBe(true);
  });
});

describe('scopes that must keep working', () => {
  it('an org-wide :org role updates any appointment in its own org', () => {
    // `:org` is the strongest scope can() resolves — there is no `:any` for
    // booking.*, and asserting one would have passed for the wrong reason.
    const owner = ctx(['booking.update:org'], { roleKey: 'ORG_OWNER', roleRank: 90 });
    expect(
      can(
        owner,
        'booking.update',
        resourceFor({ ownerUserId: SOMEONE_ELSE, locationId: BRANCH_B }),
      ),
    ).toBe(true);
  });

  it('cross-tenant stays impossible even for :org', () => {
    const owner = ctx(['booking.update:org'], { roleKey: 'ORG_OWNER', roleRank: 90 });
    expect(
      can(owner, 'booking.update', appointmentResource(OTHER_ORG, { locationId: BRANCH_A })),
    ).toBe(false);
  });

  it('cancel is authorised against the same resource, not a weaker one', () => {
    // booking.cancel took the identical shortcut in the action.
    const provider = ctx(['booking.cancel:own']);
    expect(
      can(
        provider,
        'booking.cancel',
        resourceFor({ ownerUserId: SOMEONE_ELSE, locationId: BRANCH_A }),
      ),
    ).toBe(false);
    expect(
      can(provider, 'booking.cancel', resourceFor({ ownerUserId: ME, locationId: BRANCH_A })),
    ).toBe(true);
  });
});
