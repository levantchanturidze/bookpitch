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
import type { AuthContext } from './types';

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
