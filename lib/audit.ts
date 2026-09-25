import type { Prisma, PrismaClient } from '@prisma/client';
import type { ActiveSession } from '@/lib/auth';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export type AuditAction = 'list' | 'read' | 'create' | 'update' | 'delete' | 'history_add';

/**
 * What an audit row is ABOUT.
 *
 * U-03 (production UAT, 2026-09-25): this union used to be
 * `'customer' | 'appointment' | 'payment' | 'staff'`, which is not the set of
 * things this product mutates. Every location, service, membership, reminder
 * template and organisation-setting change in lib/admin.ts was therefore
 * written as `'staff'`, usually with `entityId: null` and the real identifier
 * demoted into `meta`. A service creation rendered in /audit as
 * `create staff —`, and the entity filter had no value that would ever surface
 * it.
 *
 * That matters beyond tidiness. Membership role changes are PRIVILEGE changes
 * (CLAUDE.md invariants 3 and 4): the audit log is the append-only record they
 * are supposed to be provable from, and "who granted whom which role" was only
 * answerable by string-matching a JSON blob.
 *
 * Every value below is backed by an existing mutation site — the taxonomy is
 * widened to what the product actually does, and no further.
 *
 * `audit_log.entity` is a plain `text` column with no enum and no CHECK
 * constraint, so widening this union needs no migration and cannot fail a
 * deploy. Historical rows keep whatever they were written with; they are
 * append-only and are NOT rewritten.
 */
export type AuditEntity =
  | 'customer'
  | 'appointment'
  | 'payment'
  | 'staff'
  | 'service'
  | 'location'
  | 'membership'
  | 'organization'
  | 'message_template';

/** Every entity value, for filter UIs and tests. Order is display order. */
export const AUDIT_ENTITIES: readonly AuditEntity[] = [
  'customer',
  'appointment',
  'payment',
  'staff',
  'service',
  'location',
  'membership',
  'organization',
  'message_template',
] as const;

/**
 * Append one row to audit_log inside the caller's transaction. Because the
 * tx is opened by withOrg(), the RLS check on audit_log passes automatically.
 *
 * Runs inline in each API handler — never at "log later" boundaries — so the
 * audit trail is truly tied to the operation.
 */
export async function writeAudit(
  tx: TxClient,
  session: ActiveSession,
  action: AuditAction,
  entity: AuditEntity,
  entityId?: string | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId: session.organizationId,
      actorUserId: session.userId,
      action,
      entity,
      entityId: entityId ?? null,
      meta: (meta ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
