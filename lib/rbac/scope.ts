// -----------------------------------------------------------------------------
// RBAC Phase 6 — branch scope resolution helper.
//
// Existing state (Phase 3): can() enforces :branch grants against
// ctx.branchIds. Route handlers already filter by user-supplied
// `locationId` params. Gap: a list endpoint hit without a locationId
// param returns all branches' data for a BRANCH_MANAGER (who has
// populated ctx.branchIds).
//
// This helper resolves ctx.branchIds → the corresponding legacy
// `locations.id[]` via `branches.legacy_location_id` (Phase 2 backfill).
// Route handlers merge the result into their query's WHERE clause:
//
//   const scoped = await scopedLocationIds(ctx);
//   const where = {
//     ...(scoped ? { locationId: { in: scoped } } : {}),
//     ...(userLocationId ? { locationId: userLocationId } : {}),
//   };
//
// If both the caller's scope AND a user-supplied locationId are present,
// the user-supplied one must be inside the scope (can() already checks
// this on :branch grants when resource.branchId is passed).
// -----------------------------------------------------------------------------

import { prismaAdmin } from '@/lib/db';
import type { AuthContext, PermissionKey } from './types';
import { perm } from './types';

/**
 * Resolves the caller's ctx.branchIds to the location IDs the app-plane
 * queries currently reference. Returns:
 *   • `null` when ctx.branchIds is empty → caller has org-wide reach,
 *     no filter needed.
 *   • `string[]` (possibly empty) when populated — the list to filter
 *     queries by. An empty array intentionally matches nothing: a
 *     BRANCH_MANAGER with only cleared branches sees zero rows.
 *
 * Uses prismaAdmin because branches.legacy_location_id is queried across
 * a small, bounded set (max = number of branches in the caller's org).
 * Cached inside AuthContext per-request via the 30s ctx cache — this
 * function is called once per list endpoint per session refresh.
 */
/**
 * Companion to can()'s :own list-mode fallback (see lib/rbac/can.ts §4c).
 * Returns the userId to filter list queries by when the caller's strongest
 * grant on the given base permission is `:own` — meaning they can only
 * see rows they own.
 *
 * Returns null when the caller has :org or :branch (unrestricted or
 * branch-scoped access) OR no grant at all (can() will separately deny).
 * Callers merge into their query:
 *
 *   const ownUserId = scopedByOwn(ctx, 'booking.read');
 *   const where = {
 *     ...(ownUserId ? { staff: { userId: ownUserId } } : {}),
 *     ...(scoped ? { locationId: { in: scoped } } : {}),
 *   };
 *
 * The permission layer trusts the query layer to apply this filter —
 * same trust model as scopedLocationIds() for :branch.
 */
export function scopedByOwn(ctx: AuthContext, basePermKey: string): string | null {
  const p = basePermKey.split(':')[0]; // strip any accidental scope suffix
  if (ctx.permissions.has(perm(`${p}:org`))) return null;
  if (ctx.permissions.has(perm(`${p}:branch`))) return null;
  if (ctx.permissions.has(perm(`${p}:own`))) return ctx.userId;
  return null;
}

/**
 * Per-resource ownership resolver. Given an appointment id, returns the
 * user id that owns the booking (via `appointment.staff.userId`), or null
 * if the appointment doesn't exist / has no linked user. Callers pass the
 * result into `requirePermission(ctx, perm, { organizationId, ownerUserId })`
 * so `:own`-scoped roles get evaluated against the actual owner rather
 * than passing the F-09 list-mode fallback.
 *
 * Runs via `prismaAdmin` because callers hitting this predate their
 * `withOrg(tx)` block (they need the owner to build the guard args before
 * the transaction opens). RLS bypass is safe: this reads only a single
 * uuid, no PII, and the caller is already gated on `activeOrganizationId`
 * matching the appointment's org via a follow-up query.
 */
export async function resolveBookingOwner(
  appointmentId: string,
  activeOrganizationId: string,
): Promise<string | null> {
  const row = await prismaAdmin.appointment.findFirst({
    where: { id: appointmentId, organizationId: activeOrganizationId },
    select: { staff: { select: { userId: true } } },
  });
  return row?.staff?.userId ?? null;
}

/**
 * Same for a waitlist row — resolves via a two-step lookup (waitlist has
 * `staffId` as a column with no Prisma relation to Staff). Returns null
 * if the entry has no assigned staff (a flexible customer request) or the
 * staff row has no linked user.
 */
export async function resolveWaitlistOwner(
  waitlistId: string,
  activeOrganizationId: string,
): Promise<string | null> {
  const row = await prismaAdmin.waitlist.findFirst({
    where: { id: waitlistId, organizationId: activeOrganizationId },
    select: { staffId: true },
  });
  if (!row?.staffId) return null;
  const staff = await prismaAdmin.staff.findFirst({
    where: { id: row.staffId, organizationId: activeOrganizationId },
    select: { userId: true },
  });
  return staff?.userId ?? null;
}

export async function scopedLocationIds(ctx: AuthContext): Promise<string[] | null> {
  if (ctx.branchIds.size === 0) return null;
  const rows = await prismaAdmin.branch.findMany({
    where: {
      id: { in: [...ctx.branchIds] },
      legacyLocationId: { not: null },
    },
    select: { legacyLocationId: true },
  });
  return rows.map((r) => r.legacyLocationId!).filter((v): v is string => v !== null);
}
