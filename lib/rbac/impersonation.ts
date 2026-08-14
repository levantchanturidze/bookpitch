// -----------------------------------------------------------------------------
// RBAC Phase 5 — permissions blocked during an impersonation session.
//
// Spec §7.1 rule 5: impersonation is a diagnostic power. It must not be
// usable to destroy state, exfiltrate data in bulk, change billing, or
// read clinical records. The set below is enforced by `can()` — any
// permission listed here returns false when `ctx.isImpersonating=true`,
// regardless of whether the underlying role would grant it.
//
// This is NOT a role restriction — it's a session-mode restriction. The
// role assignments are untouched; the impersonating actor loses these
// specific capabilities only while the impersonation session is active.
//
// Test hook (__setRestrictedDuringImpersonation) is preserved so a
// specific test can probe a narrower or wider set without patching the
// module.
// -----------------------------------------------------------------------------

import type { PermissionKey } from './types';
import { perm } from './types';

const DEFAULT_RESTRICTED: ReadonlySet<PermissionKey> = new Set([
  // ---- Destructive operations (spec §7.1 rule 5 — "delete") ----
  perm('org.delete'),
  perm('staff.deactivate'),
  perm('client.merge'),
  perm('platform.org.delete'),
  perm('platform.org.suspend'),
  perm('platform.org.owner.change'),

  // ---- Bulk exports (spec §7.1 rule 5 — "bulk export") ----
  perm('client.export'),
  perm('report.export'),

  // ---- Billing changes (spec §7.1 rule 5 — "billing changes") ----
  perm('org.billing.manage'),
  perm('org.ownership.transfer'),
  perm('platform.billing.manage'),

  // ---- Clinical records (spec §7.1 rule 5 — "clinical records") ----
  // read + write are both restricted: peeking through impersonation
  // isn't a workaround. If clinical access is needed, break-glass is
  // the intended (audited, re-authenticated) path.
  perm('clinical_note.create'),
  perm('clinical_note.read:own'),
  perm('clinical_note.read:any'),
  perm('clinical_note.attachment.manage'),

  // ---- Configuration changes (SEC-005 — spec §7.1 rule 5 generalized) ----
  // Feature toggles govern clinical-note visibility (providerClinicalNotesOthers)
  // and PII tiers (frontdeskClientFullHistory). Flipping them during
  // impersonation is a two-step clinical/PII exfiltration: enable the
  // toggle, read the newly-visible data via a normal role, disable the
  // toggle. Blocking here breaks step 1. `platform.role.assign` and
  // `platform.org.create` are deliberately NOT in the set — the former
  // audits as the actor identity (traceable), the latter is a legitimate
  // support-diagnostic action.
  perm('platform.config.manage'),
]);

export let RESTRICTED_DURING_IMPERSONATION: ReadonlySet<PermissionKey> = DEFAULT_RESTRICTED;

/** Test-only helper. Do not call from application code. */
export function __setRestrictedDuringImpersonation(next: ReadonlySet<PermissionKey>): void {
  RESTRICTED_DURING_IMPERSONATION = next;
}

/** Test-only helper: revert to the default set. */
export function __resetRestrictedDuringImpersonation(): void {
  RESTRICTED_DURING_IMPERSONATION = DEFAULT_RESTRICTED;
}
