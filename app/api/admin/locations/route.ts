import type { NextRequest } from 'next/server';
import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { createLocation, listLocations } from '@/lib/admin';

export async function GET() {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'org.branch.manage',
      { organizationId: ctx.activeOrganizationId! },
      'admin',
    );
    return { locations: await listLocations(ctxToSession(ctx)) };
  });
}

export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'org.branch.manage',
      { organizationId: ctx.activeOrganizationId! },
      'admin',
    );
    const body = await req.json().catch(() => null);
    return { location: await createLocation(ctxToSession(ctx), body) };
  });
}
