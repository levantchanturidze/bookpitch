import type { NextRequest } from 'next/server';
import { requireRole, withApi } from '@/lib/auth';
import { createService, listServices } from '@/lib/admin';

export async function GET() {
  return withApi(async () => {
    const session = await requireRole('owner');
    return { services: await listServices(session) };
  });
}

export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const body = await req.json().catch(() => null);
    return { service: await createService(session, body) };
  });
}
