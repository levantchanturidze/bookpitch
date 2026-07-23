import type { NextRequest } from 'next/server';
import { requireSession, withApi, InvalidInputError } from '@/lib/auth';
import { switchActiveOrg } from '@/lib/org-switch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/session/switch  { organizationId }
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireSession();
    const body = (await req.json().catch(() => null)) as { organizationId?: unknown } | null;
    const organizationId =
      typeof body?.organizationId === 'string' ? body.organizationId : '';
    if (!organizationId) throw new InvalidInputError('organizationId is required');
    await switchActiveOrg(session.userId, organizationId);
    return { ok: true, organizationId };
  });
}
