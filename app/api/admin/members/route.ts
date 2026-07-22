import type { NextRequest } from 'next/server';
import { requireRole, withApi } from '@/lib/auth';
import { inviteMember, listMembers } from '@/lib/admin';

export async function GET() {
  return withApi(async () => {
    const session = await requireRole('owner');
    return { members: await listMembers(session) };
  });
}

export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const body = await req.json().catch(() => null);
    return await inviteMember(session, body);
  });
}
