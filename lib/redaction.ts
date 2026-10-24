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
