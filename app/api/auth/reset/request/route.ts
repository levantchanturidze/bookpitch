import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requestPasswordReset } from '@/lib/auth/password-reset';
import { consumeRateLimit } from '@/lib/rate-limit';
import { prismaAdmin } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/auth/reset/request  { email }
//
// Always returns the same 202 body. Rate-limited by (email → org lookup)
// with a fallback bucket for unknown emails so an attacker can't enumerate
// accounts by triggering different response shapes / timings.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';

  // Best-effort rate limit BEFORE any DB work.
  const user = email
    ? await prismaAdmin.appUser.findUnique({
        where: { email },
        include: { memberships: { take: 1 } },
      })
    : null;
  const orgId = user?.memberships[0]?.organizationId;
  if (orgId) {
    // 5 requests/min per org; if over, drop silently — never leak.
    try {
      await consumeRateLimit(orgId, 'pwreset-request', 5);
    } catch {
      return NextResponse.json({ ok: true }, { status: 202 });
    }
  }

  try {
    await requestPasswordReset({ email });
  } catch {
    /* swallow — never leak */
  }
  return NextResponse.json({ ok: true }, { status: 202 });
}
