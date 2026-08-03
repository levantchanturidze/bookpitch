import type { PrismaClient } from '@prisma/client';
import { withOrg } from '@/lib/db';
import { InvalidInputError, type ActiveSession } from '@/lib/auth';
import { notifyEvent } from '@/lib/notifications';
import { log } from '@/lib/logger';

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

export async function listWaitlist(
  session: ActiveSession,
  opts: { scopedLocationIds?: string[] | null; ownUserId?: string | null } = {},
) {
  return withOrg(session.organizationId, async (tx) => {
    // F-09 companion: :own-scoped roles (PROVIDER's booking.read:own) see
    // only entries assigned to their staff record. Waitlist has staffId
    // as a bare column (no Prisma relation), so resolve the caller's
    // staff.id set first and filter waitlist.staffId IN (...). Flexible
    // entries (staffId null) are excluded.
    let ownStaffIds: string[] | null = null;
    if (opts.ownUserId) {
      const staff = await tx.staff.findMany({
        where: { userId: opts.ownUserId },
        select: { id: true },
      });
      ownStaffIds = staff.map((s) => s.id);
    }
    return tx.waitlist.findMany({
      where: {
        status: { in: ['pending', 'notified'] },
        // Phase 6 branch scoping. Waitlist entries have an optional
        // locationId (customers can be "flexible") — include:
        //   • rows in the caller's scoped locations
        //   • rows with no locationId (flexible)
        // A BRANCH_MANAGER shouldn't get to poach a flexible customer
        // out of another branch's queue; the receiving-side workflow
        // still filters by the actor's branches when converting to
        // an appointment.
        ...(opts.scopedLocationIds
          ? { OR: [{ locationId: null }, { locationId: { in: opts.scopedLocationIds } }] }
          : {}),
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

  // Single rolled-up notification — one bell for staff, not N bells.
  await notifyEvent(tx, cancelledOrgId, {
    type: 'waitlist',
    title: `Slot opened — ${rows.length} waitlist match${rows.length === 1 ? '' : 'es'}`,
    body: `${cancelled.startsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  });

  log.info('waitlist.notified', {
    organizationId: cancelledOrgId,
    appointmentId: cancelled.id,
    matched: rows.length,
  });
  return { matched: rows.length };
}
