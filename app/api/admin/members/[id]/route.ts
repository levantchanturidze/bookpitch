import type { NextRequest } from 'next/server';
import type { UserRole } from '@prisma/client';
import { InvalidInputError, requireRole, withApi } from '@/lib/auth';
import { removeMember, updateMemberRole } from '@/lib/admin';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { role?: unknown };
    if (typeof body.role !== 'string') throw new InvalidInputError('role is required');
    await updateMemberRole(session, id, body.role as UserRole);
    return { ok: true };
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const { id } = await params;
    await removeMember(session, id);
    return { ok: true };
  });
}
