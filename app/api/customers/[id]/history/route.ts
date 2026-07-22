import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { InvalidInputError, requireRole, withApi } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';

// POST /api/customers/[id]/history → append one treatment_history entry.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const session = await requireRole('owner', 'practitioner', 'receptionist');
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as
      | { label?: unknown; occurredOn?: unknown }
      | null;

    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!label) throw new InvalidInputError('label is required');

    const occurredOn =
      typeof body?.occurredOn === 'string' && body.occurredOn.length > 0
        ? new Date(body.occurredOn)
        : null;

    const result = await withOrg(session.organizationId, async (tx) => {
      // Verify the customer belongs to the caller's org (RLS already guards,
      // but this returns a clean 404 vs. a raw FK error).
      const parent = await tx.customer.findUnique({ where: { id }, select: { id: true } });
      if (!parent) return null;

      const history = await tx.treatmentHistory.create({
        data: { customerId: id, label, occurredOn },
      });
      await writeAudit(tx, session, 'history_add', 'customer', id, { historyId: history.id });
      return history;
    });

    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return {
      history: {
        id: result.id,
        label: result.label,
        occurredOn: result.occurredOn ? result.occurredOn.toISOString().slice(0, 10) : null,
        createdAt: result.createdAt.toISOString(),
      },
    };
  });
}
