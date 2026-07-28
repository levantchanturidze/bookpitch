// -----------------------------------------------------------------------------
// RBAC Phase 3 — core types.
//
// AuthContext is the caller's resolved authorization state for a single
// active organization. Built by lib/rbac/context.ts::buildAuthContext, cached
// per membership for 30s, consumed by can() and requirePermission().
// -----------------------------------------------------------------------------

/** Roles live in one of three planes — spec §1. */
export type Plane = 'platform' | 'organization' | 'consumer';

/**
 * Permission-key scope suffix (spec §5). `:own | :branch | :org | :platform`
 * are the four core scopes; `limited/unlimited` are discount tiers;
 * `basic/contact/full` are client-detail tiers.
 */
export type Scope =
  | 'own' | 'branch' | 'org' | 'platform'
  | 'limited' | 'unlimited'
  | 'basic' | 'contact' | 'full';

/**
 * Permission key — the string form matches the rows in the `permissions`
 * table. Branded to keep raw strings from leaking into can() without a
 * deliberate cast. `booking.read:branch` is a PermissionKey; a random string
 * is not.
 */
export type PermissionKey = string & { readonly __permKey: unique symbol };
export const perm = (s: string): PermissionKey => s as PermissionKey;

/**
 * A resource being acted on. All fields optional — `can()` treats missing
 * fields as "no constraint from this dimension":
 *   • organizationId absent → the caller is not asserting a specific tenant
 *     (e.g. platform-plane operations)
 *   • branchId absent → no branch-level scoping
 *   • ownerUserId absent → no :own resolution
 */
export type Resource = {
  readonly organizationId?: string;
  readonly branchId?: string;
  readonly ownerUserId?: string;
};

/**
 * Everything can() needs to reach a decision without hitting the DB.
 *
 * Immutable — the cache in context.ts returns the same object across calls
 * for the same (membershipId, sessionVersion). Do not mutate.
 */
export type AuthContext = {
  readonly userId: string;
  readonly email: string;

  /** The membership row backing this context. Null when the user is
   *  operating in the platform plane only (no org active). */
  readonly membershipId: string | null;
  readonly activeOrganizationId: string | null;

  /** Role key of the active membership (ORG_OWNER, PROVIDER, …). Null when
   *  the caller has no org-plane membership active. */
  readonly roleKey: string | null;
  readonly roleRank: number;

  /** Org-plane permissions granted by the active membership's role. */
  readonly permissions: ReadonlySet<PermissionKey>;

  /** Platform-plane permissions granted by users.platform_role_id, if any. */
  readonly platformPermissions: ReadonlySet<PermissionKey>;

  /**
   * Branches this membership is scoped to. Empty set = unrestricted within
   * the org (spec §4.2: absent membership_branches row means no branch
   * restriction). BRANCH_MANAGER + multi-branch FRONT_DESK populate it.
   */
  readonly branchIds: ReadonlySet<string>;

  /** Impersonation state. Always false in Phase 3; Phase 5 populates. */
  readonly isImpersonating: boolean;

  /** Session version at build time. Used by the cache to detect staleness. */
  readonly sessionVersion: number;

  /** Org lifecycle status. Suspended/archived → can() denies everything
   *  spec §9 rule ("suspended organization → deny", CLAUDE.md invariant 2). */
  readonly organizationStatus: 'trial' | 'active' | 'suspended' | 'archived' | null;
};
