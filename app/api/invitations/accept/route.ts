import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { acceptInvitation } from '@/lib/invitations';
import { InvalidInputError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/invitations/accept  { token, password?, fullName? }
// Public (the invitee doesn't have a session yet).
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    token?: unknown;
    password?: unknown;
    fullName?: unknown;
  } | null;
  try {
    const result = await acceptInvitation({
      token: typeof body?.token === 'string' ? body.token : '',
      password: typeof body?.password === 'string' ? body.password : undefined,
      fullName: typeof body?.fullName === 'string' ? body.fullName : undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
