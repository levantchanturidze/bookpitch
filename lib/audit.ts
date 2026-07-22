import type { Prisma, PrismaClient } from '@prisma/client';
import type { ActiveSession } from '@/lib/auth';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export type AuditAction = 'list' | 'read' | 'create' | 'update' | 'delete' | 'history_add';
export type AuditEntity = 'customer' | 'appointment' | 'payment' | 'staff';

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
