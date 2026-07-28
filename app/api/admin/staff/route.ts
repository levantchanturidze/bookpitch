import type { NextRequest } from 'next/server';
import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { createStaff, listStaff } from '@/lib/admin';

export async function GET() {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'staff.update', { organizationId: ctx.activeOrganizationId! }, 'admin');
    return { staff: await listStaff(ctxToSession(ctx)) };
  });
}

export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'staff.update', { organizationId: ctx.activeOrganizationId! }, 'admin');
    const body = await req.json().catch(() => null);
    return { staff: await createStaff(ctxToSession(ctx), body) };
  });
}
