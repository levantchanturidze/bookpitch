import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { consumeReset } from '@/lib/auth/password-reset';
import { InvalidInputError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/auth/reset/consume  { token, newPassword }
//
// No session required — the token IS the auth. Applies a bumped
// sessionVersion so any live JWTs for the user are invalidated within
// the ~5s auth session-version cache TTL.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    token?: unknown;
    newPassword?: unknown;
  } | null;
  const token = typeof body?.token === 'string' ? body.token : '';
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';

  try {
    await consumeReset({ token, newPassword });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InvalidInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
