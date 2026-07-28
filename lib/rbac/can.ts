// -----------------------------------------------------------------------------
// RBAC Phase 3 — can(ctx, permission, resource?).
//
// Evaluation order matches spec §10 exactly. Each branch fails closed —
// there is no fall-through path that grants without a matching permission
// row in ctx.permissions or ctx.platformPermissions.
//
// Two important edge cases baked in:
//
//   • Suspended / archived orgs. CLAUDE.md invariant 2 ("Fail closed. …
//     suspended organization → deny"). Rejected before the scope check so
//     no permission bundle can override it.
//
//   • Empty branchIds means "unrestricted within the org" (spec §4.2:
//     absent membership_branches row). A :branch permission with an empty
//     branchIds set is allowed to reach any branch in ctx.activeOrganizationId.
//     BRANCH_MANAGER and multi-branch FRONT_DESK populate branchIds; every
//     other role leaves it empty.
// -----------------------------------------------------------------------------

import type { AuthContext, PermissionKey, Resource } from './types';
import { perm } from './types';
import { RESTRICTED_DURING_IMPERSONATION } from './impersonation';

export function can(
  ctx: AuthContext,
  permission: PermissionKey | string,
  resource?: Resource,
): boolean {
  const p = permission as PermissionKey;

  // 1. Platform plane. Never touches org data; the platform permission set
  //    is authoritative and does not care about active org state.
  if (String(p).startsWith('platform.')) {
    return ctx.platformPermissions.has(p);
  }

  // Phase 5: break-glass session unlocks reads across tenant boundaries
  // for SUPER_ADMIN (spec §7.2). The session may target one org or be
  // org-agnostic; we only bypass tenant isolation when the target
  // matches (or is unrestricted). Writes and destructive actions are
  // still bound by the permission set — break-glass is a read lever.
  const bgTarget = ctx.breakGlass?.targetOrganizationId ?? null;
  const bgReaches =
    ctx.isBreakGlass &&
    (!resource?.organizationId || bgTarget === null || bgTarget === resource.organizationId);

  // 2. Org-plane operations normally require an active org membership.
  //    Break-glass on reads is the exception — a platform-only SUPER_ADMIN
  //    with an active break-glass session may read PII and clinical data
  //    from the targeted org even without a membership row.
  if (!ctx.membershipId || !ctx.activeOrganizationId) {
    if (bgReaches && isBreakGlassReadableKey(String(p))) return true;
    return false;
  }

  // 2a. Suspended / archived orgs deny everything org-plane. Break-glass
  //     overrides so SUPER_ADMIN can inspect a suspended org (fraud triage,
  //     deletion prep).
  if ((ctx.organizationStatus === 'suspended' || ctx.organizationStatus === 'archived') &&
      !bgReaches) {
    return false;
  }

  // 2b. Tenant isolation. If the caller asserted a resource in a different
  //     org, refuse without ever consulting the permission set. This is the
  //     line spec §10 comments call "the single most important check".
  //     Break-glass with a matching target is the audited exception.
  if (resource?.organizationId && resource.organizationId !== ctx.activeOrganizationId) {
    if (bgReaches) return true;
    return false;
  }

  // 2c. Break-glass short-circuit for clinical + PII reads (spec §7.2 —
  //     the whole point of the lever). Placed AFTER tenant isolation so
  //     the resource must live inside the break-glass target (or be
  //     unrestricted). Every such read is audited via withPlatformApi.
  if (bgReaches && isBreakGlassReadableKey(String(p))) return true;

  // 3. Impersonation restrictions (spec §7.1 rule 5). Populated set,
  //    defined in lib/rbac/impersonation.ts.
  if (ctx.isImpersonating && RESTRICTED_DURING_IMPERSONATION.has(p)) {
    return false;
  }

  // 4. Scope resolution. Check strongest scope first, then weaker scopes.
  //    Each strong-scope grant subsumes the weaker ones (spec §5).
  const granted = ctx.permissions;

  // 4a. :org — unrestricted within the org.
  if (granted.has(perm(`${p}:org`))) return true;

  // 4b. :branch — resolve against ctx.branchIds. Two shapes:
  //     • Empty ctx.branchIds → unrestricted (FRONT_DESK is :branch by role
  //       but has no per-branch scoping). Always allow.
  //     • Populated ctx.branchIds (BRANCH_MANAGER):
  //         - resource.branchId specified → must be in the set.
  //         - resource.branchId absent    → list-mode call. The caller's
  //           query is expected to filter results by ctx.branchIds. Grant
  //           passes the guard; per-row visibility is the query's job.
  if (granted.has(perm(`${p}:branch`))) {
    if (ctx.branchIds.size === 0) return true;
    if (!resource?.branchId) return true;
    return ctx.branchIds.has(resource.branchId);
  }

  // 4c. :own — resource ownership must match the caller.
  if (granted.has(perm(`${p}:own`))) {
    return !!resource?.ownerUserId && resource.ownerUserId === ctx.userId;
  }

  // 4d. Scope-less grant. A few permission keys (booking.create, client.create)
  //     don't take a scope suffix — presence in the set is the whole check.
  if (granted.has(p)) return true;

  return false;
}

/**
 * Keys that break-glass exposes latently — reads of client PII and
 * clinical records that a role without a matching org membership would
 * normally never reach. See spec §7.2. Kept as a small, explicit list
 * rather than "any org-plane read" so break-glass never accidentally
 * grants a mutation.
 */
function isBreakGlassReadableKey(p: string): boolean {
  if (p.startsWith('clinical_note.read')) return true;
  if (p === 'client.read:basic' || p === 'client.read:contact' || p === 'client.read:full') return true;
  return false;
}
