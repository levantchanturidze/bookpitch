import type { NextRequest } from 'next/server';
import type { UserRole } from '@prisma/client';
import { InvalidInputError, ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { removeMember, updateMemberRole } from '@/lib/admin';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'staff.role.assign', { organizationId: ctx.activeOrganizationId! }, 'admin');
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { role?: unknown };
    if (typeof body.role !== 'string') throw new InvalidInputError('role is required');
    await updateMemberRole(ctxToSession(ctx), id, body.role as UserRole);
    return { ok: true };
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'staff.deactivate', { organizationId: ctx.activeOrganizationId! }, 'admin');
    const { id } = await params;
    await removeMember(ctxToSession(ctx), id);
    return { ok: true };
  });
}
