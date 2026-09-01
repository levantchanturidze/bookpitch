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
import { isDeniedByRole } from './role-denials';

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
  if (
    (ctx.organizationStatus === 'suspended' || ctx.organizationStatus === 'archived') &&
    !bgReaches
  ) {
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

  // 4b. Role-level denials (F16-012). Consulted above the granted set, so a
  //     stale role_permissions row cannot allow what the role must never hold.
  //     This is what makes migration 63's rollout ordering irrelevant: the
  //     data removes the grant, this refuses it either way.
  if (isDeniedByRole(ctx.roleKey, String(p))) {
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
  //     List-mode fallback mirrors :branch (line 103): if no specific
  //     resource.ownerUserId was passed, grant the call and expect the
  //     caller's query to filter results by ctx.userId. Callers must use
  //     scopedByOwn() from lib/rbac/scope.ts to derive that filter — the
  //     permission layer trusts the query layer here, same trust model as
  //     :branch scope. Without this fallback a role with only :own scope
  //     (e.g. PROVIDER's booking.read:own) can never list ANYTHING under
  //     enforcement mode.
  if (granted.has(perm(`${p}:own`))) {
    if (!resource?.ownerUserId) return true;
    return resource.ownerUserId === ctx.userId;
  }

  // 4d. Scope-less grant. A few permission keys (booking.create, client.create)
  //     don't take a scope suffix — presence in the set is the whole check.
  if (granted.has(p)) return true;

  // 4e. SEC-008 — org-toggle-based elevation. Some org toggles grant an
  //     additional permission to a specific role at request time. Kept
  //     OUT of ctx.permissions on purpose: (a) toggle flips take effect
  //     immediately, without waiting for the 30s AuthContext cache TTL;
  //     (b) the elevation lives here so a caller reading the seed can't
  //     find a grant that "shouldn't be there" — the elevation is
  //     explicit in code, not in the role→permissions bundle. Every
  //     path that changes based on a toggle documents it in the SEC-008
  //     entry of docs/rbac-security-review.md.
  if (toggleGrantsPermission(ctx, p)) return true;

  return false;
}

/**
 * SEC-008 — three org toggles that were writable + audited but consulted
 * by no code, until this landed. Each maps to a role → permission
 * elevation:
 *
 *   • providerFinancialReports    → grants report.branch AND
 *     report.financial:org to PROVIDER + SENIOR_PROVIDER. Off by
 *     default; PROVIDER cannot reach analytics or financial reports
 *     until the owner turns it on.
 *
 *   • providerClinicalNotesOthers → grants clinical_note.read:any to
 *     PROVIDER + SENIOR_PROVIDER (they already have :own). Off by
 *     default; a PROVIDER can only read their own clinical notes.
 *     `clinical_note.*` permissions have no endpoint yet, so today
 *     this elevation shows up structurally (can() returns true) but
 *     the observable behaviour change is downstream — see
 *     `toCustomerDetailDto` where the customer's clinicalNotes field
 *     is redacted from responses when the caller lacks
 *     clinical_note.read:any (or client.read:full).
 *
 *   • frontdeskClientFullHistory  → grants client.read:full to
 *     FRONT_DESK (they have :contact only). Off by default; front-desk
 *     sees name/phone/email but not allergies, clinicalNotes, or the
 *     full treatment history. `toCustomerDetailDto` is the enforcement
 *     point — it strips those fields when the caller can't read :full.
 *
 * A response body probe per toggle lives in tests/security-review.test.ts
 * (§ SEC-008 — proves the /api/customers/[id] and /api/customers
 * responses actually differ when a toggle is flipped, not just that a
 * requirePermission would deny).
 */
function toggleGrantsPermission(ctx: AuthContext, p: PermissionKey): boolean {
  const role = ctx.roleKey;
  const t = ctx.orgToggles;

  if ((role === 'PROVIDER' || role === 'SENIOR_PROVIDER') && t.providerFinancialReports) {
    if (p === perm('report.branch')) return true;
    if (p === perm('report.financial:org')) return true;
    if (p === perm('report.financial:branch')) return true;
  }

  if ((role === 'PROVIDER' || role === 'SENIOR_PROVIDER') && t.providerClinicalNotesOthers) {
    if (p === perm('clinical_note.read:any')) return true;
  }

  if (role === 'FRONT_DESK' && t.frontdeskClientFullHistory) {
    if (p === perm('client.read:full')) return true;
  }

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
  if (p === 'client.read:basic' || p === 'client.read:contact' || p === 'client.read:full')
    return true;
  return false;
}
