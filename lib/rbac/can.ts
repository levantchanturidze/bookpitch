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

  // 2. Org-plane operations require an active org membership.
  if (!ctx.membershipId || !ctx.activeOrganizationId) return false;

  // 2a. Suspended / archived orgs deny everything org-plane.
  if (ctx.organizationStatus === 'suspended' || ctx.organizationStatus === 'archived') {
    return false;
  }

  // 2b. Tenant isolation. If the caller asserted a resource in a different
  //     org, refuse without ever consulting the permission set. This is the
  //     line spec §10 comments call "the single most important check".
  if (resource?.organizationId && resource.organizationId !== ctx.activeOrganizationId) {
    return false;
  }

  // 3. Impersonation restrictions. Populated by Phase 5.
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
