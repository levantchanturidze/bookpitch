import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { listInsurers } from '@/lib/insurance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/insurance/insurers — distinct insurer_name values on this org's
// customers. Used to populate the export page dropdown.
export async function GET() {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'service.manage', { organizationId: ctx.activeOrganizationId! }, 'insurance');
    return { insurers: await listInsurers(ctxToSession(ctx)) };
  });
}
