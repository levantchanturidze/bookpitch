import type { NextRequest } from 'next/server';
import { InvalidInputError, requireRole, withApi } from '@/lib/auth';
import { anonymizeCustomer, type AnonymizeReason } from '@/lib/gdpr';

// POST /api/customers/[id]/anonymize  Body: { reason: 'gdpr'|'retention'|'admin' }
// Owner-only. Redacts PII in place — the row itself stays so FK-linked
// appointments/payments remain coherent.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = (typeof body.reason === 'string' ? body.reason : 'gdpr') as AnonymizeReason;
    if (!['gdpr', 'retention', 'admin'].includes(reason)) {
      throw new InvalidInputError('reason must be gdpr | retention | admin');
    }
    await anonymizeCustomer(session, id, reason);
    return { ok: true };
  });
}
