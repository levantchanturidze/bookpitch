import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import {
  buildUpdateData,
  parseUpdateInput,
  toCustomerDetailDto,
  toCustomerDto,
} from '@/lib/customers';

// GET /api/customers/[id] → detail + treatment_history.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'client.read:contact', { organizationId: ctx.activeOrganizationId! }, 'customers');
    const session = ctxToSession(ctx);
    const { id } = await params;

    const customer = await withOrg(session.organizationId, async (tx) => {
      const row = await tx.customer.findUnique({
        where: { id },
        include: { treatmentHistory: { orderBy: { createdAt: 'desc' } } },
      });
      if (!row) return null;
      await writeAudit(tx, session, 'read', 'customer', id);
      return toCustomerDetailDto(row);
    });

    if (!customer) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return { customer };
  });
}

// PATCH /api/customers/[id] → partial update; encrypts changed sensitive fields.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'client.read:contact', { organizationId: ctx.activeOrganizationId! }, 'customers');
    const session = ctxToSession(ctx);
    const { id } = await params;
    const input = parseUpdateInput(await req.json().catch(() => null));
    const { data, fields } = buildUpdateData(input);

    const customer = await withOrg(session.organizationId, async (tx) => {
      const existing = await tx.customer.findUnique({ where: { id }, select: { id: true } });
      if (!existing) return null;
      const row = await tx.customer.update({ where: { id }, data });
      await writeAudit(tx, session, 'update', 'customer', id, { fields });
      return toCustomerDto(row);
    });

    if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return { customer };
  });
}

// DELETE /api/customers/[id] → hard delete. FK is ON DELETE RESTRICT on
// appointments, so customers with any appointment history return 409 instead
// of losing the audit trail. Soft-delete / anonymization arrives in P3.3.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'client.merge', { organizationId: ctx.activeOrganizationId! }, 'customers');
    const session = ctxToSession(ctx);
    const { id } = await params;

    const result = await withOrg(session.organizationId, async (tx) => {
      const existing = await tx.customer.findUnique({ where: { id }, select: { id: true } });
      if (!existing) return { status: 'not_found' as const };
      try {
        await tx.customer.delete({ where: { id } });
      } catch (err: unknown) {
        // Prisma raises P2003 on FK violation.
        const code = (err as { code?: string } | null)?.code;
        if (code === 'P2003') return { status: 'has_deps' as const };
        throw err;
      }
      await writeAudit(tx, session, 'delete', 'customer', id);
      return { status: 'ok' as const };
    });

    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (result.status === 'has_deps') {
      return NextResponse.json(
        { error: 'Customer has appointments and cannot be deleted' },
        { status: 409 },
      );
    }
    return { ok: true };
  });
}
