import type { NextRequest } from 'next/server';
import { requireSession, withApi, InvalidInputError } from '@/lib/auth';
import { removeSubscription } from '@/lib/push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/push/unsubscribe  { endpoint }
export async function POST(req: NextRequest) {
  return withApi(async () => {
    await requireSession();
    const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
    if (!endpoint) throw new InvalidInputError('endpoint is required');
    await removeSubscription(endpoint);
    return { ok: true };
  });
}
