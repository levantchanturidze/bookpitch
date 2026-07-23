import type { PrismaClient } from '@prisma/client';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

// -----------------------------------------------------------------------------
// GDPR request tracking. We don't add a new table — audit_log already carries
// enough signal: entity='customer' + action in {export,anonymize} + meta.
// This module surfaces those rows for the /settings/privacy UI along with a
// simple SLA countdown against DSR_DEADLINE_DAYS (default 30 for GDPR).
// -----------------------------------------------------------------------------

const DEFAULT_DSR_DEADLINE_DAYS = 30;

export function dsrDeadlineDays(): number {
  const raw = process.env.DSR_DEADLINE_DAYS;
  if (!raw) return DEFAULT_DSR_DEADLINE_DAYS;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n < 1 ? DEFAULT_DSR_DEADLINE_DAYS : n;
}

export type DsrRow = {
  id: string;
  action: 'export' | 'anonymize';
  entityId: string | null;
  customerName: string | null;
  actorEmail: string | null;
  at: string;
  slaDueAt: string;
  slaOverdue: boolean;
};

export async function recentDsrActivity(
  tx: TxClient,
  opts: { limit?: number } = {},
): Promise<DsrRow[]> {
  const deadlineDays = dsrDeadlineDays();
  const rows = await tx.auditLog.findMany({
    where: {
      entity: 'customer',
      action: { in: ['export', 'anonymize'] },
    },
    orderBy: { at: 'desc' },
    take: opts.limit ?? 50,
    include: { actor: { select: { email: true } } },
  });

  const customerIds = Array.from(
    new Set(rows.map((r) => r.entityId).filter((v): v is string => !!v)),
  );
  const customers = customerIds.length
    ? await tx.customer.findMany({
        where: { id: { in: customerIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(customers.map((c) => [c.id, c.name]));

  const now = Date.now();
  return rows.map((r) => {
    const slaDue = new Date(r.at.getTime() + deadlineDays * 24 * 3600 * 1000);
    return {
      id: r.id.toString(),
      action: r.action as 'export' | 'anonymize',
      entityId: r.entityId,
      customerName: r.entityId ? (nameById.get(r.entityId) ?? null) : null,
      actorEmail: r.actor?.email ?? null,
      at: r.at.toISOString(),
      slaDueAt: slaDue.toISOString(),
      slaOverdue: slaDue.getTime() < now,
    };
  });
}
