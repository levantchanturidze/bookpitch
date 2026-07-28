// -----------------------------------------------------------------------------
// RBAC Phase 5 — audit log query for the platform-plane viewer.
//
// Callers: platform.audit.read grantees (SUPER_ADMIN + 👁️ others).
// Reads via prismaAdmin because the caller is querying across orgs.
//
// SUPPORT_AGENT restriction: platform.audit.read has 👁️ per spec §6.1,
// which we interpret as "can query but see aggregate / non-PII fields
// only". Implementation: same query, different projection — actor email
// is masked (name → initials) for SUPPORT_AGENT callers. This is the
// only platform-side surface where any user-identifying string reaches
// SUPPORT_AGENT.
// -----------------------------------------------------------------------------

import { prismaAdmin } from '@/lib/db';

export type PlatformAuditFilter = {
  actorUserId?: string | null;
  organizationId?: string | null;
  action?: string | null;
  fromDate?: Date | null;
  toDate?: Date | null;
  limit?: number;
};

export async function queryPlatformAudit(
  filter: PlatformAuditFilter,
  opts: { maskPii: boolean },
) {
  const where: Record<string, unknown> = {};
  if (filter.actorUserId)     where.actorUserId = filter.actorUserId;
  if (filter.organizationId)  where.organizationId = filter.organizationId;
  if (filter.action)          where.action = { startsWith: filter.action };
  if (filter.fromDate || filter.toDate) {
    where.at = {
      ...(filter.fromDate ? { gte: filter.fromDate } : {}),
      ...(filter.toDate ? { lt: filter.toDate } : {}),
    };
  }

  const rows = await prismaAdmin.auditLog.findMany({
    where,
    orderBy: { at: 'desc' },
    take: filter.limit ?? 200,
    include: {
      actor:      { select: { email: true, fullName: true } },
      onBehalfOf: { select: { email: true, fullName: true } },
      organization: { select: { name: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id.toString(),
    at: r.at.toISOString(),
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    organizationId: r.organizationId,
    organizationName: r.organization?.name ?? null,
    actorEmail: opts.maskPii ? maskEmail(r.actor?.email ?? null) : r.actor?.email ?? null,
    actorName: opts.maskPii ? maskName(r.actor?.fullName ?? null) : r.actor?.fullName ?? null,
    onBehalfOfEmail: opts.maskPii
      ? maskEmail(r.onBehalfOf?.email ?? null)
      : r.onBehalfOf?.email ?? null,
    reason: r.reason,
    impersonationSessionId: r.impersonationSessionId,
    breakGlassSessionId: r.breakGlassSessionId,
    meta: opts.maskPii ? redactMeta(r.meta) : r.meta,
  }));
}

// SUPPORT_AGENT masking. Keeps enough for troubleshooting ("was it the
// same user?" / "was it the same domain?") without revealing identity.
function maskEmail(e: string | null): string | null {
  if (!e) return null;
  const [local, domain] = e.split('@');
  if (!local || !domain) return '***';
  return `${local[0] ?? '*'}***@${domain}`;
}

function maskName(n: string | null): string | null {
  if (!n) return null;
  const parts = n.split(/\s+/);
  return parts.map((p) => (p[0] ?? '?') + '.').join(' ');
}

function redactMeta(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object') return meta;
  // Coarse redaction: strip anything that looks like PII (email, name,
  // phone, ticket subject). SUPPORT_AGENT's meta view keeps action-shape
  // context (fields changed, counts) without values.
  const PII_KEYS = new Set(['email', 'targetEmail', 'name', 'fullName', 'phone', 'notes']);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    out[k] = PII_KEYS.has(k) ? '[redacted]' : v;
  }
  return out;
}
