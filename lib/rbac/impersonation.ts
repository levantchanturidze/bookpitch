// -----------------------------------------------------------------------------
// RBAC Phase 3 — impersonation restriction set.
//
// Populated in Phase 5 with the actual list from spec §7.1: destructive ops,
// bulk exports, billing changes, clinical records. Kept here as an empty set
// so can()'s signature is spec-shaped from the start (no signature churn
// when Phase 5 ships).
//
// Tests can rebind via a probe pattern — see tests/rbac-can.test.ts.
// -----------------------------------------------------------------------------

import type { PermissionKey } from './types';

// eslint-disable-next-line prefer-const  -- intentionally rebindable for tests
export let RESTRICTED_DURING_IMPERSONATION: ReadonlySet<PermissionKey> = new Set();

/** Test-only helper. Do not call from application code. */
export function __setRestrictedDuringImpersonation(next: ReadonlySet<PermissionKey>): void {
  RESTRICTED_DURING_IMPERSONATION = next;
}
