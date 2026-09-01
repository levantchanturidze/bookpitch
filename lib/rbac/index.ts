// -----------------------------------------------------------------------------
// RBAC Phase 3 — public API.
//
// Import from `@/lib/rbac`, not from the sub-modules directly. Phase 4 will
// use this barrel when swapping requireRole() → requirePermission() across
// the codebase.
// -----------------------------------------------------------------------------

export { can } from './can';
export { requireAuthContext, requirePermission } from './guard';
// P17-013. Pages and non-root layouts use this instead of requirePermission so a
// denial becomes a 403 and the forbidden.tsx boundary rather than a 500.
// tests/phase17-forbidden-boundary.test.ts pins that split.
export { requirePagePermission } from './page-guard';
export { canManageRoleAssignment } from './rank';
export { buildAuthContext } from './context';
export { perm } from './types';
export { scopedLocationIds, scopedByOwn, resolveBookingOwner, resolveWaitlistOwner } from './scope';
export { loadOrgToggles, updateOrgToggles, DEFAULT_TOGGLES } from './toggles';
export type { OrgToggles } from './toggles';
export type { AuthContext, Resource, Plane, Scope, PermissionKey } from './types';
