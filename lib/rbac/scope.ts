// -----------------------------------------------------------------------------
// RBAC — scope resolution for `:own` and `:branch`.
//
// can() decides; this module supplies the facts it decides on. Two jobs:
//
//   LIST paths name no resource, so can() grants `:own` and `:branch` in LIST
//   mode and trusts the query to filter. scopedLocationIds() and scopedByOwn()
//   ARE that filter — every list path must apply both.
//
//   CONCRETE paths (anything acting on one id) must resolve the resource first
//   and authorise against it. The resolvers below return owner AND branch
//   together, from the same row, so neither can be forgotten.
//
// Branch ids and location ids are different uuids. The app plane stores
// `location_id` on rows; `ctx.branchIds` holds `branches.id`; the two tables are
// linked 1:1 by `branches.legacy_location_id`. Lists therefore filter by the
// LOCATIONS of the caller's branches, and concrete resources carry the BRANCH
// of their location. Mixing the two is what made an assigned branch impossible
// to match (docs/scoped-rbac-assumption-audit.md §3.4).
// -----------------------------------------------------------------------------

import type { Prisma } from '@prisma/client';
import { withOrg } from '@/lib/db';
import type { AuthContext, Resource } from './types';
import { perm } from './types';

/**
 * Companion to can()'s :own list-mode fallback (see lib/rbac/can.ts §4c).
 * Returns the userId to filter list queries by when the caller's strongest
 * grant on the given base permission is `:own` — meaning they can only
 * see rows they own.
 *
 * Returns null when the caller has :org or :branch (the branch filter is
 * scopedLocationIds' job) OR no grant at all (can() will separately deny).
 * Callers merge into their query:
 *
 *   const ownUserId = scopedByOwn(ctx, 'booking.read');
 *   const where = {
 *     ...(ownUserId ? { staff: { userId: ownUserId } } : {}),
 *     ...(scoped ? { locationId: { in: scoped } } : {}),
 *   };
 */
export function scopedByOwn(ctx: AuthContext, basePermKey: string): string | null {
  const p = basePermKey.split(':')[0]; // strip any accidental scope suffix
  if (ctx.permissions.has(perm(`${p}:org`))) return null;
  if (ctx.permissions.has(perm(`${p}:branch`))) return null;
  if (ctx.permissions.has(perm(`${p}:own`))) return ctx.userId;
  return null;
}

/**
 * The LOCATIONS a list query on `basePermKey` may return rows from, decided by
 * the caller's strongest grant — the same order can() walks:
 *
 *   :org        → null, no location filter
 *   :branch     → the locations of the caller's branches; `[]` when the set is
 *                 EMPTY, so the query returns zero rows
 *   :own        → null; rows are restricted by owner instead (scopedByOwn)
 *   scope-less  → null
 *   no grant    → `[]` — can() has already refused, and this fails closed anyway
 *
 * Callers must treat `[]` as "nothing", never as "no filter":
 *
 *   const scoped = await scopedLocationIds(ctx, 'booking.read');
 *   const where = scoped ? { locationId: { in: scoped } } : {};
 *
 * This used to take no permission and return `null` for every caller with an
 * empty branch set — which made every FRONT_DESK org-wide, and would have
 * restricted an `:org` caller who happened to hold branch rows.
 *
 * SEC-007: the branch lookup runs through withOrg, so RLS on `branches` is the
 * enforcer even if a JWT bug ever put an out-of-org branch id in the set.
 */
export async function scopedLocationIds(
  ctx: AuthContext,
  basePermKey: string,
): Promise<string[] | null> {
  const p = basePermKey.split(':')[0];
  if (ctx.permissions.has(perm(`${p}:org`))) return null;
  if (ctx.permissions.has(perm(`${p}:branch`))) return locationsOfBranches(ctx);
  if (ctx.permissions.has(perm(`${p}:own`))) return null;
  if (ctx.permissions.has(perm(p))) return null;
  return [];
}

async function locationsOfBranches(ctx: AuthContext): Promise<string[]> {
  if (ctx.branchIds.size === 0 || !ctx.activeOrganizationId) return [];
  const rows = await withOrg(ctx.activeOrganizationId, (tx) =>
    tx.branch.findMany({
      where: {
        id: { in: [...ctx.branchIds] },
        legacyLocationId: { not: null },
      },
      select: { legacyLocationId: true },
    }),
  );
  return rows.map((r) => r.legacyLocationId).filter((v): v is string => v !== null);
}

/**
 * Owner of one appointment (`appointment.staff.userId`), or null when the id
 * does not resolve in the caller's organisation or its staff has no linked user.
 *
 * OWNER ONLY — never enough to authorise a mutation on its own, because it
 * leaves `:branch` in list mode. Use resolveAppointmentResource(). Kept for the
 * RLS probes in tests/security-review.test.ts §P7, which pin that this read is
 * tenant-scoped.
 */
export async function resolveBookingOwner(
  appointmentId: string,
  activeOrganizationId: string,
): Promise<string | null> {
  const row = await withOrg(activeOrganizationId, (tx) =>
    tx.appointment.findFirst({
      where: { id: appointmentId },
      select: { staff: { select: { userId: true } } },
    }),
  );
  return row?.staff?.userId ?? null;
}

// -----------------------------------------------------------------------------
// 5.2 — the resource shape a CONCRETE appointment must be authorised against.
//
// `can()` grants `:own` and `:branch` when no ownerUserId / branchId is passed.
// That fallback is LIST mode and it is deliberate — without it a role holding
// only `booking.read:own` could never list anything. The cost is that a
// MUTATION which forgets to name its resource silently takes the same path and
// is allowed against any row in the organisation.
//
// U-05 (production C7 UAT, 2026-09-26) made `ownerUserId` three-state: a key
// that is PRESENT AND NULL means "resolved, and it has no owner", which `can()`
// treats as deny for `:own`; a key that is ABSENT still means list mode.
// `'ownerUserId' in opts` is the discriminator.
//
// `branchId` follows the same rule and carries a BRANCH id. It used to be
// filled from the appointment's location id, which no branch set can contain,
// and a missing location silently OMITTED it — list mode again.
// -----------------------------------------------------------------------------
export function appointmentResource(
  organizationId: string,
  opts: { ownerUserId?: string | null; branchId?: string | null } = {},
): Resource {
  return {
    organizationId,
    ...('branchId' in opts ? { branchId: opts.branchId ?? null } : {}),
    ...('ownerUserId' in opts ? { ownerUserId: opts.ownerUserId ?? null } : {}),
  };
}

/** Prisma selection for "the branch of this row's location". */
const LOCATION_BRANCH = { select: { branch: { select: { id: true } } } } as const;

/**
 * Resolve ONE appointment into the resource its mutation must be authorised
 * against — owner and branch together, from the same row.
 *
 * Returns `null` when the id does not resolve INSIDE the caller's organisation.
 * The read goes through withOrg, so a cross-tenant id is indistinguishable from
 * a non-existent one here — which is the correct answer to give the caller.
 */
export async function resolveAppointmentResource(
  appointmentId: string,
  activeOrganizationId: string,
): Promise<Resource | null> {
  const row = await withOrg(activeOrganizationId, (tx) =>
    tx.appointment.findFirst({
      where: { id: appointmentId },
      select: { location: LOCATION_BRANCH, staff: { select: { userId: true } } },
    }),
  );
  if (!row) return null;
  return appointmentResource(activeOrganizationId, {
    branchId: row.location.branch?.id ?? null,
    ownerUserId: row.staff?.userId ?? null,
  });
}

/**
 * Resolve ONE staff row — the user it is linked to (`:own`) and the branch of
 * its location (`:branch`). `null` when it does not resolve in the caller's
 * organisation.
 *
 * U-06: the availability API route and setAvailabilityAction authorise through
 * this one resolver, so the two paths cannot disagree again.
 */
export async function resolveStaffResource(
  staffId: string,
  activeOrganizationId: string,
): Promise<Resource | null> {
  const row = await withOrg(activeOrganizationId, (tx) =>
    tx.staff.findFirst({
      where: { id: staffId },
      select: { userId: true, location: LOCATION_BRANCH },
    }),
  );
  if (!row) return null;
  return {
    organizationId: activeOrganizationId,
    branchId: row.location.branch?.id ?? null,
    ownerUserId: row.userId ?? null,
  };
}

// -----------------------------------------------------------------------------
// Waitlist branch attribution — owner decision D2
// (docs/scoped-rbac-assumption-audit.md §6).
//
// The waitlist form never sets `location_id`, so keying on that column alone
// made every product-created row branchless. A row's branch is therefore
// DERIVED:
//
//   its own location  →  else its staff member's location  →  else its
//   service's location  →  else none: an org-level row, reachable only
//   through an `:org` grant.
//
// The list filter and the concrete resolver below implement that one rule
// twice — once as a Prisma WHERE, once from a loaded row.
// tests/branch-scoping.test.ts ("D2 — the list and the concrete resolver agree
// on every waitlist row") pins that they agree for every attribution case,
// because two copies of a rule is how paths drift.
// -----------------------------------------------------------------------------

/** WHERE fragment: waitlist rows whose derived branch is one of `locationIds`. */
export function waitlistInLocations(locationIds: string[]): Prisma.WaitlistWhereInput {
  return {
    OR: [
      { locationId: { in: locationIds } },
      { locationId: null, staff: { is: { locationId: { in: locationIds } } } },
      {
        locationId: null,
        staffId: null,
        service: { is: { locationId: { in: locationIds } } },
      },
    ],
  };
}

/**
 * Resolve ONE waitlist row — owner via its staff member's linked user, branch
 * derived as above. `null` when it does not resolve in the caller's
 * organisation.
 */
export async function resolveWaitlistResource(
  waitlistId: string,
  activeOrganizationId: string,
): Promise<Resource | null> {
  const row = await withOrg(activeOrganizationId, (tx) =>
    tx.waitlist.findFirst({
      where: { id: waitlistId },
      select: {
        location: LOCATION_BRANCH,
        staff: { select: { userId: true, location: LOCATION_BRANCH } },
        service: { select: { location: LOCATION_BRANCH } },
      },
    }),
  );
  if (!row) return null;
  const branchId = row.location
    ? (row.location.branch?.id ?? null)
    : row.staff
      ? (row.staff.location.branch?.id ?? null)
      : row.service
        ? (row.service.location.branch?.id ?? null)
        : null;
  return {
    organizationId: activeOrganizationId,
    branchId,
    ownerUserId: row.staff?.userId ?? null,
  };
}
