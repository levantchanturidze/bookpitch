import webpush from 'web-push';
import { withoutRls } from '@/lib/db';
import { log } from '@/lib/logger';

// -----------------------------------------------------------------------------
// Web Push subscriptions + sender.
//
// VAPID keys live in the env:
//   VAPID_PUBLIC_KEY  (also shipped to the client as NEXT_PUBLIC_VAPID_PUBLIC_KEY)
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT     ("mailto:ops@bookpitch.ge")
//
// Generate a keypair with:  npx web-push generate-vapid-keys --json
//
// Payloads MUST NOT carry patient PII — the browser stores push messages
// while the tab is closed, and the OS may surface them on a lock screen.
// Notification bodies are counts + generic phrases only.
// -----------------------------------------------------------------------------

let vapidReady = false;
function ensureVapid(): boolean {
  if (vapidReady) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT ?? 'mailto:ops@bookpitch.ge';
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subj, pub, priv);
  vapidReady = true;
  return true;
}

export type SaveSubscriptionInput = {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
};

export async function saveSubscription(input: SaveSubscriptionInput): Promise<{ id: string }> {
  return withoutRls(async (tx) => {
    const row = await tx.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        userId: input.userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
      },
      update: {
        userId: input.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
        lastSeenAt: new Date(),
      },
      select: { id: true },
    });
    return row;
  });
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await withoutRls((tx) =>
    tx.pushSubscription.delete({ where: { endpoint } }).catch(() => null),
  );
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
};

/**
 * Sends a payload to every push subscription for userId. 404/410 responses
 * from the push service mean the subscription is dead — we delete those.
 */
export async function pushToUser(
  userId: string,
  payload: PushPayload,
): Promise<{ delivered: number; pruned: number }> {
  if (!ensureVapid()) {
    log.warn('push.vapid_missing');
    return { delivered: 0, pruned: 0 };
  }
  const subs = await withoutRls((tx) =>
    tx.pushSubscription.findMany({ where: { userId } }),
  );
  if (!subs.length) return { delivered: 0, pruned: 0 };

  let delivered = 0;
  const dead: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
        );
        delivered += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          dead.push(s.endpoint);
        } else {
          log.warn('push.send_failed', { status, error: (err as Error).message });
        }
      }
    }),
  );

  if (dead.length) {
    await withoutRls((tx) =>
      tx.pushSubscription.deleteMany({ where: { endpoint: { in: dead } } }),
    );
  }
  return { delivered, pruned: dead.length };
}
