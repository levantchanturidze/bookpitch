import type { PrismaClient } from '@prisma/client';
import { withOrg } from '@/lib/db';
import { InvalidInputError, type ActiveSession } from '@/lib/auth';
import { scopedByOwn, scopedLocationIds, waitlistInLocations } from '@/lib/rbac/scope';
import type { AuthContext } from '@/lib/rbac/types';
import { notifyEvent } from '@/lib/notifications';
import { log } from '@/lib/logger';
import { toLocalDate, toLocalTimeHHMM } from '@/lib/tz';
import { writeAudit } from '@/lib/audit';
import { lockCustomerForNewRecords } from '@/lib/redaction';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * What a waitlist audit row says about the entry.
 *
 * Identifiers only: whose place it is, and the three attribution fields that
 * decide the entry's branch (owner decision D2). `notes` is free text — anything
 * a receptionist typed about a patient — so it is never copied, and neither is
 * any name or contact detail; the customer id resolves those for someone
 * allowed to see them.
 */
function waitlistAuditFacts(row: {
  customerId: string;
  locationId: string | null;
  staffId: string | null;
  serviceId: string | null;
}) {
  return {
    customerId: row.customerId,
    locationId: row.locationId,
    staffId: row.staffId,
    serviceId: row.serviceId,
  };
}

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
    // The customer must exist in this organisation and not be redacted, held
    // under a lock until the entry is written (see lockCustomerForNewRecords).
    const customer = await lockCustomerForNewRecords(tx, session.organizationId, input.customerId);
    if (customer === 'missing') throw new InvalidInputError('unknown customer');
    if (customer === 'redacted') {
      throw new InvalidInputError('this customer has been anonymized');
    }
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
    // Same transaction: no entry exists without its audit row, and a failed
    // audit write fails the add.
    await writeAudit(tx, session, 'create', 'waitlist', row.id, waitlistAuditFacts(row));
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
        where: { organizationId: session.organizationId, userId: scope.ownUserId },
        select: { id: true },
      });
      ownStaffIds = staff.map((s) => s.id);
    }
    return tx.waitlist.findMany({
      where: {
        // Explicit, not only RLS: CLAUDE.md invariant 1.
        organizationId: session.organizationId,
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
  await withOrg(session.organizationId, async (tx) => {
    const row = await tx.waitlist.delete({
      where: { id, organizationId: session.organizationId },
    });
    // The row is gone afterwards, so the audit row is the only record of what
    // was removed — hence the attribution facts and the status it had.
    await writeAudit(tx, session, 'delete', 'waitlist', id, {
      ...waitlistAuditFacts(row),
      status: row.status,
    });
  });
}

/**
 * A customer's waitlist entries are deleted WITH the customer:
 * `waitlist_customer_fk` is ON DELETE CASCADE, and a cascade writes no audit
 * row. Both customer-deletion paths used to remove entries that way, leaving no
 * `waitlist` record of them (Codex review on #114).
 *
 * Call this inside the deleting transaction, BEFORE deleting the customer. It
 * locks the customer row FOR UPDATE, so no entry can be added for them until
 * the transaction ends (an insert's foreign-key check needs a lock that
 * conflicts with it), then locks and returns exactly the entries the cascade
 * will remove. It writes nothing, so a delete refused afterwards (P2003, the
 * customer has appointments) leaves nothing to undo. Returns null when the
 * customer row is not there to lock.
 *
 * The entries are locked, not only read. An entry removed by someone else
 * (DELETE /api/waitlist/[id]) after a plain read but before the cascade stayed
 * in the result, so the caller audited a removal it did not make: two `delete`
 * rows for one entry (Codex review on #114). Locked, an entry being removed is
 * waited for and then left out.
 *
 * After the delete succeeds, pass the result to auditWaitlistRemovedWithCustomer.
 */
export async function lockCustomerWaitlist(
  tx: TxClient,
  organizationId: string,
  customerId: string,
) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM customers
     WHERE id = ${customerId}::uuid AND organization_id = ${organizationId}::uuid
       FOR UPDATE`;
  if (locked.length === 0) return null;
  const entries = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM waitlist
     WHERE organization_id = ${organizationId}::uuid AND customer_id = ${customerId}::uuid
     ORDER BY id
       FOR UPDATE`;
  return tx.waitlist.findMany({
    where: { organizationId, id: { in: entries.map((e) => e.id) } },
    select: {
      id: true,
      status: true,
      customerId: true,
      locationId: true,
      staffId: true,
      serviceId: true,
    },
    orderBy: { id: 'asc' },
  });
}

export type CustomerWaitlistEntries = NonNullable<Awaited<ReturnType<typeof lockCustomerWaitlist>>>;
export type WaitlistRemovalReason = 'customer_deleted' | 'customer_redacted';

/** The audit meta for an entry removed with its customer: identifiers, never the notes. */
export function waitlistRemovalMeta(
  e: CustomerWaitlistEntries[number],
  reason: WaitlistRemovalReason,
) {
  return { ...waitlistAuditFacts(e), status: e.status, reason };
}

/** One `delete` audit row per entry removed with its customer (deleted or redacted). */
export async function auditWaitlistRemovedWithCustomer(
  tx: TxClient,
  session: ActiveSession,
  entries: CustomerWaitlistEntries,
  reason: WaitlistRemovalReason = 'customer_deleted',
): Promise<void> {
  for (const e of entries) {
    await writeAudit(tx, session, 'delete', 'waitlist', e.id, waitlistRemovalMeta(e, reason));
  }
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
 * enforcer even if the organisation were ever computed wrong.
 *
 * Takes the SESSION of whoever cancelled: flipping an entry to `notified`
 * changes who staff will contact, so it is audited per entry, attributed to the
 * person whose cancellation caused it.
 */
export async function notifyWaitlistForCancelled(
  tx: TxClient,
  session: ActiveSession,
  cancelled: {
    id: string;
    staffId: string;
    serviceId: string | null;
    locationId: string;
    startsAt: Date;
    endsAt: Date;
  },
): Promise<{ matched: number }> {
  // Every query here names the organisation explicitly. RLS also filters, but
  // the caller's transaction is the only thing establishing it, and SEC-007
  // was exactly this function running under a bypassing client (CLAUDE.md
  // invariant 1: a tenant query without organization_id is a bug).
  //
  // One statement: the entries marked notified ARE the entries audited below.
  // Found first and updated after, an entry removed in between was skipped by
  // the update but still audited as notified (Codex review on #114). A null
  // staff, service or location on the entry matches any; a null serviceId on
  // the appointment matches only entries without one, as before.
  const cancelledOrgId = session.organizationId;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE waitlist
       SET status = 'notified', notified_at = transaction_timestamp()
     WHERE organization_id = ${cancelledOrgId}::uuid
       AND status = 'pending'
       AND preferred_from <= ${cancelled.startsAt}::timestamptz
       AND preferred_to >= ${cancelled.endsAt}::timestamptz
       AND (staff_id IS NULL OR staff_id = ${cancelled.staffId}::uuid)
       AND (service_id IS NULL OR service_id = ${cancelled.serviceId}::uuid)
       AND (location_id IS NULL OR location_id = ${cancelled.locationId}::uuid)
    RETURNING id`;
  if (!rows.length) return { matched: 0 };

  for (const r of rows) {
    await writeAudit(tx, session, 'update', 'waitlist', r.id, {
      status: 'notified',
      appointmentId: cancelled.id,
    });
  }

  const loc = await tx.location.findFirst({
    where: { id: cancelled.locationId, organizationId: cancelledOrgId },
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
