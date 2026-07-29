import { NextResponse, type NextRequest } from 'next/server';
import { ctxToSession, withApiRaw } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { exportCustomerData } from '@/lib/gdpr';

// POST /api/customers/[id]/export — returns the full PII export as a JSON
// attachment. Writes audit_log('read', 'customer', id, {export}).
//
// Wrapped in withApiRaw so thrown InvalidInputError/NotFoundError/etc.
// surface as mapped 4xx JSON instead of leaking a raw 500/stack trace.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiRaw(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'client.export', { organizationId: ctx.activeOrganizationId! }, 'customers');
    const { id } = await params;
    const data = await exportCustomerData(ctxToSession(ctx), id);
    return new NextResponse(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="customer-${id}-export.json"`,
        'cache-control': 'no-store',
      },
    });
  });
}
