import type { NextRequest } from 'next/server';
import { InvalidInputError, ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { anonymizeCustomer, type AnonymizeReason } from '@/lib/gdpr';

// POST /api/customers/[id]/anonymize  Body: { reason: 'gdpr'|'retention'|'admin' }
// Redacts PII in place — the row itself stays so FK-linked appointments /
// payments remain coherent. Guarded by `client.export` (the strongest
// customer-data permission; owners have it, admins can be granted).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'client.export', { organizationId: ctx.activeOrganizationId! }, 'customers');
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = (typeof body.reason === 'string' ? body.reason : 'gdpr') as AnonymizeReason;
    if (!['gdpr', 'retention', 'admin'].includes(reason)) {
      throw new InvalidInputError('reason must be gdpr | retention | admin');
    }
    await anonymizeCustomer(ctxToSession(ctx), id, reason);
    return { ok: true };
  });
}
