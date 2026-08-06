import type { PrismaClient } from '@prisma/client';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

// -----------------------------------------------------------------------------
// Audit-log query helpers used by the owner-only /audit page. Kept out of
// lib/audit.ts because that file is imported by every writer — the viewer
// is only ever used by one place.
// -----------------------------------------------------------------------------

export type AuditFilter = {
  customerId?: string | null;
  actorUserId?: string | null;
  action?: string | null;
  entity?: string | null;
  fromDate?: Date | null;
  toDate?: Date | null;
  limit?: number;
};

export type AuditRow = {
  id: string; // bigserial stringified
  action: string;
  entity: string;
  entityId: string | null;
  actorEmail: string | null;
  actorId: string | null;
  at: string;
  meta: unknown;
  customerName: string | null; // resolved for entity='customer' when possible
};

export async function queryAudit(tx: TxClient, filter: AuditFilter): Promise<AuditRow[]> {
  const rows = await tx.auditLog.findMany({
    where: {
      ...(filter.entity ? { entity: filter.entity } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.actorUserId ? { actorUserId: filter.actorUserId } : {}),
      ...(filter.customerId
        ? { entity: filter.entity ?? 'customer', entityId: filter.customerId }
        : {}),
      ...(filter.fromDate || filter.toDate
        ? {
            at: {
              ...(filter.fromDate ? { gte: filter.fromDate } : {}),
              ...(filter.toDate ? { lte: filter.toDate } : {}),
            },
          }
        : {}),
    },
    orderBy: { at: 'desc' },
    take: filter.limit ?? 200,
    include: {
      actor: { select: { email: true } },
    },
  });

  // Resolve customer names for any entity='customer' rows to make the
  // viewer more useful. Cheap batched lookup.
  const customerIds = Array.from(
    new Set(
      rows.filter((r) => r.entity === 'customer' && r.entityId).map((r) => r.entityId as string),
    ),
  );
  const customers = customerIds.length
    ? await tx.customer.findMany({
        where: { id: { in: customerIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(customers.map((c) => [c.id, c.name]));

  return rows.map((r) => ({
    id: r.id.toString(),
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    actorEmail: r.actor?.email ?? null,
    actorId: r.actorUserId,
    at: r.at.toISOString(),
    meta: r.meta,
    customerName: r.entity === 'customer' && r.entityId ? (nameById.get(r.entityId) ?? null) : null,
  }));
}
