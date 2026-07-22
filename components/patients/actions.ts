'use server';

import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import {
  buildCreateData,
  buildUpdateData,
  parseCreateInput,
  parseUpdateInput,
  toCustomerDto,
  type CustomerCreateInput,
  type CustomerUpdateInput,
} from '@/lib/customers';

// -----------------------------------------------------------------------------
// Server Actions for the /patients client UI. Mirror the /api/customers routes
// but shave the HTTP hop for internal callers. Each returns the fresh DTO so
// the client can update its local state, then revalidatePath refreshes the
// server-rendered list.
// -----------------------------------------------------------------------------

export async function createCustomerAction(input: CustomerCreateInput) {
  const session = await requireRole('owner', 'practitioner', 'receptionist');
  const parsed = parseCreateInput(input);

  const customer = await withOrg(session.organizationId, async (tx) => {
    const row = await tx.customer.create({
      data: buildCreateData(parsed, session.organizationId),
    });
    await writeAudit(tx, session, 'create', 'customer', row.id);
    return toCustomerDto(row);
  });

  revalidatePath('/patients');
  return customer;
}

export async function updateCustomerAction(id: string, input: CustomerUpdateInput) {
  const session = await requireRole('owner', 'practitioner', 'receptionist');
  const parsed = parseUpdateInput(input);
  const { data, fields } = buildUpdateData(parsed);

  const customer = await withOrg(session.organizationId, async (tx) => {
    const row = await tx.customer.update({ where: { id }, data });
    await writeAudit(tx, session, 'update', 'customer', id, { fields });
    return toCustomerDto(row);
  });

  revalidatePath('/patients');
  return customer;
}

export async function deleteCustomerAction(id: string): Promise<
  { ok: true } | { ok: false; reason: 'has_appointments' | 'not_found' }
> {
  const session = await requireRole('owner', 'practitioner', 'receptionist');

  const result = await withOrg(session.organizationId, async (tx) => {
    const existing = await tx.customer.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return { ok: false as const, reason: 'not_found' as const };
    try {
      await tx.customer.delete({ where: { id } });
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'P2003') return { ok: false as const, reason: 'has_appointments' as const };
      throw err;
    }
    await writeAudit(tx, session, 'delete', 'customer', id);
    return { ok: true as const };
  });

  if (result.ok) revalidatePath('/patients');
  return result;
}

export async function addTreatmentHistoryAction(customerId: string, label: string) {
  const session = await requireRole('owner', 'practitioner', 'receptionist');
  const trimmed = label.trim();
  if (!trimmed) throw new Error('label is required');

  const history = await withOrg(session.organizationId, async (tx) => {
    const row = await tx.treatmentHistory.create({
      data: { customerId, label: trimmed },
    });
    await writeAudit(tx, session, 'history_add', 'customer', customerId, {
      historyId: row.id,
    });
    return row;
  });

  revalidatePath('/patients');
  return {
    id: history.id,
    label: history.label,
    occurredOn: history.occurredOn ? history.occurredOn.toISOString().slice(0, 10) : null,
    createdAt: history.createdAt.toISOString(),
  };
}
