import type { PrismaClient } from '@prisma/client';
import { withOrg } from '@/lib/db';
import { InvalidInputError, type ActiveSession } from '@/lib/auth';
import { scopedByOwn, scopedLocationIds, waitlistInLocations } from '@/lib/rbac/scope';
import type { AuthContext } from '@/lib/rbac/types';
import { notifyEvent } from '@/lib/notifications';
import { log } from '@/lib/logger';
import { toLocalDate, toLocalTimeHHMM } from '@/lib/tz';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

// -----------------------------------------------------------------------------
// Customer waitlist.
//
// A row means: "customer wants an appointment matching (staffId?, serviceId?,
// locationId?) sometime in [preferredFrom, preferredTo]".
// When a booked slot opens (appointment status flips to cancelled), we find
// entries whose (staff, service, location, window) covers the freed slot and
// notify the org. Actually sending an SMS/email to the waitlist customer is
// intentionally out of scope for MVP — the notification tells staff, who
// then reach out via their existing channel. Keeps the abuse surface small.
// -----------------------------------------------------------------------------

export type AddInput = {
  customerId: string;
  locationId?: string;
  staffId?: string;
  serviceId?: string;
  preferredFrom: Date;
  preferredTo: Date;
  notes?: string;
};

export async function addToWaitlist(
  session: ActiveSession,
  input: AddInput,
): Promise<{ id: string }> {
  if (input.preferredFrom >= input.preferredTo) {
    throw new InvalidInputError('preferredFrom must be before preferredTo');
  }
  return withOrg(session.organizationId, async (tx) => {
    // Sanity: customer must exist in this org (RLS makes this trivial).
    const customer = await tx.customer.findUnique({
      where: { id: input.customerId },
      select: { id: true },
    });
    if (!customer) throw new InvalidInputError('unknown customer');
    const row = await tx.waitlist.create({
      data: {
        organizationId: session.organizationId,
        customerId: input.customerId,
        locationId: input.locationId ?? null,
        staffId: input.staffId ?? null,
        serviceId: input.serviceId ?? null,
        preferredFrom: input.preferredFrom,
        preferredTo: input.preferredTo,
        notes: input.notes ?? null,
      },
    });
    return { id: row.id };
  });
}

/**
 * What a caller may see of the waitlist. REQUIRED by listWaitlist(), and built
 * from the caller's grants by waitlistScopeFor() — never assembled by hand.
 *
 * The /waitlist page used to call listWaitlist(session) with no scope at all,
 * while GET /api/waitlist passed both filters: a PROVIDER saw the whole
 * organisation's waitlist through the page (scoped-RBAC audit §3.5).
 */
export type WaitlistScope = {
  /** Locations whose rows are visible; `null` = every location (an `:org` grant). */
  scopedLocationIds: string[] | null;
  /** When set, only rows assigned to this user's staff records. */
  ownUserId: string | null;
};

export async function waitlistScopeFor(ctx: AuthContext): Promise<WaitlistScope> {
  return {
    scopedLocationIds: await scopedLocationIds(ctx, 'booking.read'),
    ownUserId: scopedByOwn(ctx, 'booking.read'),
  };
}

export async function listWaitlist(session: ActiveSession, scope: WaitlistScope) {
  return withOrg(session.organizationId, async (tx) => {
    // F-09 companion: :own-scoped roles (PROVIDER's booking.read:own) see
    // only entries assigned to their staff records. Flexible entries
    // (staffId null) are excluded.
    let ownStaffIds: string[] | null = null;
    if (scope.ownUserId) {
      const staff = await tx.staff.findMany({
        where: { userId: scope.ownUserId },
        select: { id: true },
      });
      ownStaffIds = staff.map((s) => s.id);
    }
    return tx.waitlist.findMany({
      where: {
        status: { in: ['pending', 'notified'] },
        // Branch scoping by the row's DERIVED branch (owner decision D2): its
        // location, else its staff member's, else its service's. A row with
        // none of these is org-level and reachable only with an `:org` grant.
        //
        // This used to admit every row with `location_id IS NULL`, and the
        // waitlist form never sets location_id — so the filter let every row
        // through. `[]` (no branches) matches nothing.
        ...(scope.scopedLocationIds ? waitlistInLocations(scope.scopedLocationIds) : {}),
        ...(ownStaffIds !== null ? { staffId: { in: ownStaffIds } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });
}

export async function removeFromWaitlist(session: ActiveSession, id: string): Promise<void> {
  await withOrg(session.organizationId, (tx) => tx.waitlist.delete({ where: { id } }));
}

/**
 * Called after an appointment is cancelled. Finds pending waitlist entries
 * whose (staff, service, location, window) covers the freed slot and marks
 * them notified. Emits one rolled-up notification.
 *
 * SEC-007: requires the caller's tenant-scoped tx. Previously used
 * `withoutRls` (superuser client, WHERE clause carried the only
 * organizationId filter — the exact same-shape leak vector SEC-007
 * catalogs). The caller now inlines this inside their existing
 * `withOrg(organizationId, tx => …)` block so RLS on `waitlist` is the
 * enforcer even if `cancelledOrgId` were ever computed wrong.
 */
export async function notifyWaitlistForCancelled(
  tx: TxClient,
  cancelledOrgId: string,
  cancelled: {
    id: string;
    staffId: string;
    serviceId: string | null;
    locationId: string;
    startsAt: Date;
    endsAt: Date;
  },
): Promise<{ matched: number }> {
  const rows = await tx.waitlist.findMany({
    where: {
      status: 'pending',
      preferredFrom: { lte: cancelled.startsAt },
      preferredTo: { gte: cancelled.endsAt },
      AND: [
        { OR: [{ staffId: null }, { staffId: cancelled.staffId }] },
        { OR: [{ serviceId: null }, { serviceId: cancelled.serviceId }] },
        { OR: [{ locationId: null }, { locationId: cancelled.locationId }] },
      ],
    },
    select: { id: true },
  });
  if (!rows.length) return { matched: 0 };

  await tx.waitlist.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: 'notified', notifiedAt: new Date() },
  });

  const loc = await tx.location.findUnique({
    where: { id: cancelled.locationId },
    select: { timezone: true },
  });
  const tz = loc?.timezone ?? 'UTC';

  // Single rolled-up notification — one bell for staff, not N bells.
  await notifyEvent(tx, cancelledOrgId, {
    type: 'waitlist',
    title: `Slot opened — ${rows.length} waitlist match${rows.length === 1 ? '' : 'es'}`,
    body: `${toLocalDate(cancelled.startsAt, tz)} ${toLocalTimeHHMM(cancelled.startsAt, tz)}`,
  });

  log.info('waitlist.notified', {
    organizationId: cancelledOrgId,
    appointmentId: cancelled.id,
    matched: rows.length,
  });
  return { matched: rows.length };
}
