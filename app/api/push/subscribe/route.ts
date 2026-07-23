import type { NextRequest } from 'next/server';
import { requireSession, withApi, InvalidInputError } from '@/lib/auth';
import { saveSubscription } from '@/lib/push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/push/subscribe
// Body: PushSubscriptionJSON (endpoint, keys.p256dh, keys.auth) from
// the browser's PushManager.subscribe().
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const session = await requireSession();
    const body = (await req.json().catch(() => null)) as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    } | null;
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
    const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys!.p256dh : '';
    const auth = typeof body?.keys?.auth === 'string' ? body.keys!.auth : '';
    if (!endpoint || !p256dh || !auth) {
      throw new InvalidInputError('endpoint + keys.p256dh + keys.auth are required');
    }
    return saveSubscription({
      userId: session.userId,
      endpoint,
      p256dh,
      auth,
      userAgent: req.headers.get('user-agent') ?? null,
    });
  });
}
