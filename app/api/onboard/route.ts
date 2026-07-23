import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { onboardOrg } from '@/lib/onboarding';
import { InvalidInputError } from '@/lib/auth';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/onboard
// { email, password, fullName, orgName, locationName?, locationType? }
//
// Public — no session (that's the whole point). Creates the org + owner
// in one transaction and returns identifiers. The caller then hits
// /signin with the same credentials.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  try {
    const result = await onboardOrg({
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
      fullName: String(body.fullName ?? ''),
      orgName: String(body.orgName ?? ''),
      locationName: body.locationName ? String(body.locationName) : undefined,
      locationType: (body.locationType as 'clinic' | 'salon' | undefined) ?? undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    log.error('onboard.failed', { error: (err as Error).message });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
