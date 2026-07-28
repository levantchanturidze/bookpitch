import type { NextRequest } from 'next/server';
import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { deleteLocation, updateLocation } from '@/lib/admin';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'org.branch.manage', { organizationId: ctx.activeOrganizationId! }, 'admin');
    const { id } = await params;
    const body = await req.json().catch(() => null);
    return { location: await updateLocation(ctxToSession(ctx), id, body) };
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'org.branch.manage', { organizationId: ctx.activeOrganizationId! }, 'admin');
    const { id } = await params;
    await deleteLocation(ctxToSession(ctx), id);
    return { ok: true };
  });
}
