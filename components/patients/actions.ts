'use server';

import { type ActionResult } from '@/lib/action-result';
import { safeAction } from '@/lib/safe-action';

import { revalidatePath } from 'next/cache';
import { ctxToSession, InvalidInputError } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { anonymizeCustomer, exportCustomerData, type CustomerExport } from '@/lib/gdpr';
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
  return safeAction('patients.createCustomer', async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'client.create',
      { organizationId: ctx.activeOrganizationId! },
      'customers',
    );
    const session = ctxToSession(ctx);
    const parsed = parseCreateInput(input);

    const customer = await withOrg(session.organizationId, async (tx) => {
      const row = await tx.customer.create({
        data: buildCreateData(parsed, session.organizationId),
      });
      await writeAudit(tx, session, 'create', 'customer', row.id);
      return toCustomerDto(row, { ctx });
    });

    revalidatePath('/patients');
    return customer;
  });
}

export async function updateCustomerAction(id: string, input: CustomerUpdateInput) {
  return safeAction('patients.updateCustomer', async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'client.read:contact',
      { organizationId: ctx.activeOrganizationId! },
      'customers',
    );
    const session = ctxToSession(ctx);
    const parsed = parseUpdateInput(input);
    const { data, fields } = buildUpdateData(parsed);

    const customer = await withOrg(session.organizationId, async (tx) => {
      const row = await tx.customer.update({ where: { id }, data });
      await writeAudit(tx, session, 'update', 'customer', id, { fields });
      return toCustomerDto(row, { ctx });
    });

    revalidatePath('/patients');
    return customer;
  });
}

export type CustomerDeleteOutcome =
  { deleted: true } | { deleted: false; reason: 'has_appointments' | 'not_found' };

export async function deleteCustomerAction(
  id: string,
): Promise<ActionResult<CustomerDeleteOutcome>> {
  return safeAction('patients.deleteCustomer', async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'client.merge',
      { organizationId: ctx.activeOrganizationId! },
      'customers',
    );
    const session = ctxToSession(ctx);

    const result = await withOrg(session.organizationId, async (tx) => {
      const existing = await tx.customer.findUnique({ where: { id }, select: { id: true } });
      if (!existing) return { deleted: false as const, reason: 'not_found' as const };
      try {
        await tx.customer.delete({ where: { id } });
      } catch (err: unknown) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'P2003')
          return { deleted: false as const, reason: 'has_appointments' as const };
        throw err;
      }
      await writeAudit(tx, session, 'delete', 'customer', id);
      return { deleted: true as const };
    });

    if (result.deleted) revalidatePath('/patients');
    return result;
  });
}

export async function addTreatmentHistoryAction(customerId: string, label: string) {
  return safeAction('patients.addTreatmentHistory', async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'client.read:full',
      { organizationId: ctx.activeOrganizationId! },
      'customers',
    );
    const session = ctxToSession(ctx);
    const trimmed = label.trim();
    // Was a bare Error, which is not a domain error and would therefore have
    // collapsed to the generic message. It is a validation failure and says so.
    if (!trimmed) throw new InvalidInputError('label is required');

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
  });
}

// -----------------------------------------------------------------------------
// GDPR — owner-only actions used by the Patients detail pane.
// -----------------------------------------------------------------------------

export async function exportCustomerAction(
  customerId: string,
): Promise<ActionResult<CustomerExport>> {
  return safeAction('patients.exportCustomer', async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'client.export',
      { organizationId: ctx.activeOrganizationId! },
      'customers',
    );
    return exportCustomerData(ctxToSession(ctx), customerId);
  });
}

export async function anonymizeCustomerAction(customerId: string): Promise<ActionResult<void>> {
  return safeAction('patients.anonymizeCustomer', async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'client.export',
      { organizationId: ctx.activeOrganizationId! },
      'customers',
    );
    await anonymizeCustomer(ctxToSession(ctx), customerId, 'gdpr');
    revalidatePath('/patients');
  });
}
