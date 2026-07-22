import type { NextRequest } from 'next/server';
import { requireRole, withApi } from '@/lib/auth';
import { createLocation, listLocations } from '@/lib/admin';

export async function GET() {
  return withApi(async () => {
    const session = await requireRole('owner');
    return { locations: await listLocations(session) };
  });
}

export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const body = await req.json().catch(() => null);
    return { location: await createLocation(session, body) };
  });
}
