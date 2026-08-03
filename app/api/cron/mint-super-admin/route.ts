import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { hash } from '@node-rs/argon2';
import { prismaAdmin } from '@/lib/db';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// TEMPORARY one-shot endpoint used during the 2026-08-02 secret-rotation
// incident to re-mint SUPER_ADMIN passwords when the operator has no local
// DB access. Bearer MINT_TOKEN — a random env var set immediately before
// this route deploys and deleted immediately after. This route is REMOVED
// in the very next commit.
//
// Under /api/cron/* so it's covered by the existing "cron endpoints
// authenticate via a bearer secret" allow-list in scripts/check-guards.ts.
//
// Body: { email: string, roleKey?: 'SUPER_ADMIN'|'PLATFORM_ADMIN'|... }
// Returns: { ok: true, id: string, password: string }
//
// The generated password is returned in the response body ONCE. Caller
// must not persist it — it's re-mint-able via this same endpoint until
// removed.
export async function POST(req: NextRequest) {
  const secret = process.env.MINT_TOKEN;
  if (!secret) return NextResponse.json({ error: 'MINT_TOKEN not configured' }, { status: 500 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { email?: string; roleKey?: string } | null;
  if (!body?.email || !body.email.includes('@')) {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }
  const roleKey = body.roleKey ?? 'SUPER_ADMIN';
  const ALLOWED = ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'SUPPORT_AGENT', 'BILLING_MANAGER'];
  if (!ALLOWED.includes(roleKey)) {
    return NextResponse.json({ error: 'roleKey invalid' }, { status: 400 });
  }

  const role = await prismaAdmin.role.findFirst({
    where: { key: roleKey, organizationId: null }, select: { id: true },
  });
  if (!role) return NextResponse.json({ error: 'role not found' }, { status: 500 });

  // Web Crypto — 32 random bytes, base64url. ~43 chars, well above the
  // create-platform-user 12-char floor.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const password = Buffer.from(bytes).toString('base64url');
  const passwordHash = await hash(password);

  const existing = await prismaAdmin.appUser.findUnique({
    where: { email: body.email }, select: { id: true },
  });

  let userId: string;
  if (existing) {
    await prismaAdmin.appUser.update({
      where: { id: existing.id },
      data: {
        passwordHash, status: 'active', mfaEnabled: true,
        platformRoleId: role.id,
        sessionVersion: { increment: 1 }, // kills any live JWT
      },
    });
    userId = existing.id;
  } else {
    const created = await prismaAdmin.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: body.email,
        email: body.email,
        fullName: `Platform ${roleKey}`,
        passwordHash,
        platformRoleId: role.id,
        mfaEnabled: true,
      },
      select: { id: true },
    });
    userId = created.id;
  }

  // Never log the password — only the fact of the mint.
  log.warn('mint-super-admin.executed', { userId, roleKey, email: body.email });

  return NextResponse.json({ ok: true, id: userId, password });
}
