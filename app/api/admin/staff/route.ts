import type { NextRequest } from 'next/server';
import { requireRole, withApi } from '@/lib/auth';
import { createStaff, listStaff } from '@/lib/admin';

export async function GET() {
  return withApi(async () => {
    const session = await requireRole('owner');
    return { staff: await listStaff(session) };
  });
}

export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const body = await req.json().catch(() => null);
    return { staff: await createStaff(session, body) };
  });
}
