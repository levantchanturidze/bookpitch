import type { NextRequest } from 'next/server';
import { requireRole, withApi } from '@/lib/auth';
import { deleteService, updateService } from '@/lib/admin';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const { id } = await params;
    const body = await req.json().catch(() => null);
    return { service: await updateService(session, id, body) };
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const { id } = await params;
    await deleteService(session, id);
    return { ok: true };
  });
}
