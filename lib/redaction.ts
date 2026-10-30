import type { PrismaClient } from '@prisma/client';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

// -----------------------------------------------------------------------------
// A redacted customer keeps their row (appointments and treatment history
// reference it) under a placeholder name. That name is the only marker: both
// erasure paths write it (lib/gdpr.ts), and the retention sweep and the
// monitor's backlog count skip rows that carry it.
// -----------------------------------------------------------------------------

export const REDACTED_NAME_PREFIX = 'Redacted Customer #';

/** The placeholder a redaction writes. The id suffix keeps rows tellable apart. */
export function redactedCustomerName(customerId: string): string {
  return `${REDACTED_NAME_PREFIX}${customerId.slice(0, 8)}`;
}

export function isRedactedCustomerName(name: string): boolean {
  return name.startsWith(REDACTED_NAME_PREFIX);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether new records may be attached to this customer, decided under a share
 * lock on their row and held until the caller's transaction ends.
 *
 * A redacted customer gets no new waitlist entry or appointment: its notes
 * would be new personal data about a person whose record was erased (Codex
 * review on #126). The lock is what makes the answer hold. Both erasure paths
 * take this row FOR UPDATE before clearing anything, so an erasure cannot
 * commit between this check and the caller's insert. Before, an insert that
 * had passed an existence check waited on the erasure's lock in its
 * foreign-key check, then went ahead once the erasure committed.
 */
export async function lockCustomerForNewRecords(
  tx: TxClient,
  organizationId: string,
  customerId: string,
): Promise<'live' | 'redacted' | 'missing'> {
  if (!UUID.test(customerId)) return 'missing';
  const rows = await tx.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM customers
     WHERE id = ${customerId}::uuid AND organization_id = ${organizationId}::uuid
       FOR SHARE`;
  if (rows.length === 0) return 'missing';
  return isRedactedCustomerName(rows[0].name) ? 'redacted' : 'live';
}

/**
 * Public booking's match for a returning customer: the oldest live customer of
 * this organisation with this email (case-insensitive) or phone, read FOR
 * SHARE in the caller's transaction.
 *
 * The share lock is the same one lockCustomerForNewRecords takes, and it does
 * the same job. An erasure in flight holds the row FOR UPDATE, so this read
 * waits for it, and PostgreSQL then re-checks the WHERE against what the
 * erasure committed. A redacted row has no email or phone left, so it no
 * longer matches and the booking gets a new customer, the same outcome as
 * booking after the erasure. A plain read returned the row as it was before
 * the erasure, and the booking attached to the redacted customer once the
 * erasure committed.
 *
 * Every match is locked, not just the first (there is no uniqueness on email
 * or phone), so the choice cannot change under the caller.
 */
export async function lockLiveCustomerByContact(
  tx: TxClient,
  organizationId: string,
  contact: { email: string } | { phone: string },
): Promise<{ id: string; consentAt: Date | null } | null> {
  type Row = { id: string; name: string; consent_at: Date | null };
  const rows =
    'email' in contact
      ? await tx.$queryRaw<Row[]>`
          SELECT id, name, consent_at FROM customers
           WHERE organization_id = ${organizationId}::uuid
             AND email = ${contact.email}::citext
           ORDER BY created_at, id
             FOR SHARE`
      : await tx.$queryRaw<Row[]>`
          SELECT id, name, consent_at FROM customers
           WHERE organization_id = ${organizationId}::uuid
             AND phone = ${contact.phone}
           ORDER BY created_at, id
             FOR SHARE`;
  const live = rows.find((r) => !isRedactedCustomerName(r.name));
  return live ? { id: live.id, consentAt: live.consent_at } : null;
}
