import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { prismaAdmin } from '@/lib/db';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// TEMPORARY one-shot endpoint used during the 2026-08-02 rotation
// follow-up. Fixes the DATABASE_URL mismatch by ALTERing bookpitch_app
// to a fresh generated password + returning it so the operator can
// update Vercel's DATABASE_URL to match. Bearer MINT_TOKEN. Removed in
// the very next commit after use.
export async function POST(req: NextRequest) {
  const secret = process.env.MINT_TOKEN;
  if (!secret) return NextResponse.json({ error: 'MINT_TOKEN not configured' }, { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Base64URL = [A-Za-z0-9_-]. Safe in postgres URLs without percent-encoding.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const password = Buffer.from(bytes).toString('base64url');

  // Sanity: only base64url chars — no quotes, no backslashes. This is the
  // guardrail for the $executeRawUnsafe below since ALTER USER cannot use
  // bound parameters for the password literal.
  if (!/^[A-Za-z0-9_-]+$/.test(password)) {
    return NextResponse.json({ error: 'password gen failed sanity' }, { status: 500 });
  }

  try {
    await prismaAdmin.$executeRawUnsafe(
      `ALTER USER bookpitch_app WITH PASSWORD '${password}'`
    );
  } catch (err) {
    return NextResponse.json({
      error: 'ALTER USER failed',
      code: (err as { code?: string }).code ?? 'unknown',
    }, { status: 500 });
  }

  log.warn('reset-app-role.executed', { role: 'bookpitch_app' });
  return NextResponse.json({ ok: true, password });
}
