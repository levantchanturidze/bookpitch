// -----------------------------------------------------------------------------
// RBAC Phase 3 — AuthContext construction with 30s in-memory cache.
//
// Cache design (Phase 0 Q6 answer: no Redis, in-memory is enough for MVP):
//   • Key: `${membershipId}:${sessionVersion}`. Bumping sessionVersion
//     (password reset, role change, admin revoke) evicts naturally on next
//     lookup. Membership deletion produces a lookup miss + a null return.
//   • TTL: 30s. Even without a version bump, the cache is stale-bound to
//     30s, so a role-permissions change (Phase 6 admin edit) propagates
//     within 30s to every session, everywhere.
//   • Bounded size: 1000 entries. LRU-lite — on insert when full, drop the
//     oldest entry. Good enough for a Node process serving a small SaaS.
//
// This module uses unsafePrismaAdmin (BYPASSRLS) because it queries across the
// membership → role → permissions graph, which requires reads on rows that
// don't sit inside an org context yet (users, platform roles).
// -----------------------------------------------------------------------------

import { unsafePrismaAdmin } from '@/lib/db';
import type { AuthContext, PermissionKey } from './types';
import { perm } from './types';
import { loadOrgToggles, DEFAULT_TOGGLES } from './toggles';

type CacheEntry = { ctx: AuthContext; at: number };
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 30_000;
const MAX = 1_000;

function cacheKey(membershipId: string | null, sessionVersion: number, userId: string): string {
  return membershipId
    ? `m:${membershipId}:${sessionVersion}`
    : `u:${userId}:${sessionVersion}`;
}

/** Test-only helper. Do not call from application code. */
export function __clearAuthContextCache(): void {
  CACHE.clear();
}

/**
 * Build (or return from cache) the AuthContext for the given user and
 * membership. Returns null when:
 *   • The user doesn't exist or has status != 'active'
 *   • The membership doesn't exist or its status != 'active'
 *   • The membership doesn't belong to the user
 *
 * Suspended-org and impersonation-restriction handling live in can(); this
 * function still populates the ctx for a suspended org so guards can log
 * the denial with useful info. Deleted orgs produce a null return.
 *
 * membershipId is nullable — callers with a platform-only session (no
 * active org) pass null and get an AuthContext with `permissions=empty`,
 * `platformPermissions=populated`.
 */
export async function buildAuthContext(
  userId: string,
  membershipId: string | null,
): Promise<AuthContext | null> {
  // We need sessionVersion for the cache key. One extra column read is cheap
  // and lets us fail closed on a stale JWT even if the caller forgot to
  // check it.
  const user = await unsafePrismaAdmin.appUser.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, status: true, sessionVersion: true, platformRoleId: true,
    },
  });
  if (!user || user.status !== 'active') return null;

  const key = cacheKey(membershipId, user.sessionVersion, userId);
  const now = Date.now();
  const hit = CACHE.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.ctx;

  // Fetch platform-plane data + active platform sessions in parallel.
  // Phase 5: impersonation + break-glass presence changes can() semantics,
  // so both are looked up per AuthContext build. Cached with the ctx.
  const [platformPermissions, activeImpersonation, activeBreakGlass] = await Promise.all([
    loadPlatformPermissions(user.platformRoleId),
    loadActiveImpersonation(userId),
    loadActiveBreakGlass(userId),
  ]);

  const impersonation = activeImpersonation
    ? {
        sessionId: activeImpersonation.id,
        onBehalfOfUserId: activeImpersonation.onBehalfOfUserId,
        organizationId: activeImpersonation.organizationId,
        expiresAt: activeImpersonation.expiresAt,
      }
    : null;
  const breakGlass = activeBreakGlass
    ? {
        sessionId: activeBreakGlass.id,
        expiresAt: activeBreakGlass.expiresAt,
        targetOrganizationId: activeBreakGlass.targetOrganizationId,
      }
    : null;

  let ctx: AuthContext;
  if (!membershipId) {
    ctx = {
      userId: user.id,
      email: user.email,
      membershipId: null,
      activeOrganizationId: null,
      roleKey: null,
      roleRank: 0,
      permissions: new Set(),
      platformPermissions,
      branchIds: new Set(),
      impersonation,
      isImpersonating: impersonation !== null,
      breakGlass,
      isBreakGlass: breakGlass !== null,
      sessionVersion: user.sessionVersion,
      organizationStatus: null,
      // Platform-only sessions carry the safe defaults — Phase 6 toggles
      // only matter when a resource in a specific org is being accessed,
      // and those checks either pass through can()'s org-plane branches
      // (which have a real ctx.orgToggles) or through platform.* perms
      // that don't consult toggles.
      orgToggles: DEFAULT_TOGGLES,
    };
  } else {
    const built = await buildOrgContext(user, membershipId, platformPermissions,
                                        impersonation, breakGlass);
    if (!built) return null;
    ctx = built;
  }

  // Bounded insert: if we'd overflow, drop the oldest entry.
  if (CACHE.size >= MAX) {
    const oldestKey = CACHE.keys().next().value;
    if (oldestKey !== undefined) CACHE.delete(oldestKey);
  }
  CACHE.set(key, { ctx, at: now });
  return ctx;
}

async function loadPlatformPermissions(
  platformRoleId: string | null,
): Promise<ReadonlySet<PermissionKey>> {
  if (!platformRoleId) return new Set();
  const rows = await unsafePrismaAdmin.rolePermission.findMany({
    where: { roleId: platformRoleId },
    select: { permissionKey: true },
  });
  return new Set(rows.map(r => perm(r.permissionKey)));
}

/**
 * Active impersonation session for this user, if any. Uses the partial
 * index `idx_impersonation_sessions_actor_active` so this is O(1) even
 * as history grows. Filters expired-but-not-ended rows at read time —
 * a housekeeping sweep will eventually flip their ended_at, but we
 * cannot rely on it having run.
 */
async function loadActiveImpersonation(userId: string) {
  const now = new Date();
  return unsafePrismaAdmin.impersonationSession.findFirst({
    where: {
      actorUserId: userId,
      endedAt: null,
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      onBehalfOfUserId: true,
      organizationId: true,
      expiresAt: true,
    },
    orderBy: { startedAt: 'desc' },
  });
}

async function loadActiveBreakGlass(userId: string) {
  const now = new Date();
  return unsafePrismaAdmin.breakGlassSession.findFirst({
    where: {
      actorUserId: userId,
      endedAt: null,
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      expiresAt: true,
      targetOrganizationId: true,
    },
    orderBy: { startedAt: 'desc' },
  });
}

async function buildOrgContext(
  user: { id: string; email: string; sessionVersion: number },
  membershipId: string,
  platformPermissions: ReadonlySet<PermissionKey>,
  impersonation: AuthContext['impersonation'],
  breakGlass: AuthContext['breakGlass'],
): Promise<AuthContext | null> {
  const membership = await unsafePrismaAdmin.membership.findUnique({
    where: { id: membershipId },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      status: true,
      roleId: true,
      organization: { select: { status: true } },
      roleRef: { select: { key: true, rank: true } },
      branches: { select: { branchId: true } },
    },
  });
  if (!membership) return null;
  if (membership.userId !== user.id) return null;                 // wrong user
  if (membership.status !== 'active') return null;                // suspended / removed
  if (!membership.organization) return null;                      // org deleted
  if (!membership.roleId || !membership.roleRef) return null;     // role_id NULL — pre-backfill

  // Fetch role permissions + org toggles in parallel — one round trip each,
  // both bounded by their own caches (org toggles also 30s TTL).
  const [permRows, orgToggles] = await Promise.all([
    unsafePrismaAdmin.rolePermission.findMany({
      where: { roleId: membership.roleId },
      select: { permissionKey: true },
    }),
    loadOrgToggles(membership.organizationId),
  ]);
  const permissions: ReadonlySet<PermissionKey> = new Set(
    permRows.map(r => perm(r.permissionKey)),
  );

  return {
    userId: user.id,
    email: user.email,
    membershipId: membership.id,
    activeOrganizationId: membership.organizationId,
    roleKey: membership.roleRef.key,
    roleRank: membership.roleRef.rank,
    permissions,
    platformPermissions,
    branchIds: new Set(membership.branches.map(b => b.branchId)),
    impersonation,
    isImpersonating: impersonation !== null,
    breakGlass,
    isBreakGlass: breakGlass !== null,
    sessionVersion: user.sessionVersion,
    organizationStatus: membership.organization.status as AuthContext['organizationStatus'],
    orgToggles,
  };
}
