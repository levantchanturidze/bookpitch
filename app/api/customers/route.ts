import type { NextRequest } from 'next/server';
import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { buildCreateData, parseCreateInput, toCustomerDto } from '@/lib/customers';

// GET /api/customers → list of the caller's org's customers (decrypted).
export async function GET() {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'client.read:contact', { organizationId: ctx.activeOrganizationId! }, 'customers');
    const session = ctxToSession(ctx);
    const customers = await withOrg(session.organizationId, async (tx) => {
      const rows = await tx.customer.findMany({ orderBy: { createdAt: 'desc' } });
      await writeAudit(tx, session, 'list', 'customer', null, { count: rows.length });
      return rows.map(toCustomerDto);
    });
    return { customers };
  });
}

// POST /api/customers → create a new customer with consent captured.
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'client.create', { organizationId: ctx.activeOrganizationId! }, 'customers');
    const session = ctxToSession(ctx);
    const input = parseCreateInput(await req.json().catch(() => null));

    const customer = await withOrg(session.organizationId, async (tx) => {
      const row = await tx.customer.create({
        data: buildCreateData(input, session.organizationId),
      });
      await writeAudit(tx, session, 'create', 'customer', row.id);
      return toCustomerDto(row);
    });

    return { customer };
  });
}
