import type { NextRequest } from 'next/server';
import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { createService, listServices } from '@/lib/admin';

export async function GET() {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'service.manage', { organizationId: ctx.activeOrganizationId! }, 'admin');
    return { services: await listServices(ctxToSession(ctx)) };
  });
}

export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'service.manage', { organizationId: ctx.activeOrganizationId! }, 'admin');
    const body = await req.json().catch(() => null);
    return { service: await createService(ctxToSession(ctx), body) };
  });
}
