'use client';

import { useCallback, useEffect, useState } from 'react';

export type NotificationItem = {
  id: string;
  type: 'booking' | 'payment' | 'reminder' | 'system';
  title: string;
  body: string | null;
  read: boolean;
  createdAt: string;
};

// -----------------------------------------------------------------------------
// useNotifications — one hook per <Shell>.
// 1) Fetches the current list via GET /api/notifications.
// 2) Opens EventSource('/api/notifications/stream') to receive live updates.
// 3) Exposes markAllRead + clear that hit the REST endpoints and update
//    local state.
//
// EventSource auto-reconnects with backoff — we accept that (dev-server
// restarts briefly drop then re-attach).
// -----------------------------------------------------------------------------

type StreamEvent = {
  id: string;
  orgId: string;
  type: NotificationItem['type'];
  title: string;
  body: string | null;
  createdAt: string;
};

export function useNotifications() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Initial fetch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/notifications', { cache: 'no-store' });
        if (!res.ok) throw new Error(`GET /api/notifications: ${res.status}`);
        const body = (await res.json()) as { notifications: NotificationItem[] };
        if (!cancelled) setItems(body.notifications);
      } catch {
        // If it fails, the stream may still work — keep going.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live stream.
  useEffect(() => {
    // SSR guard — EventSource is browser-only.
    if (typeof window === 'undefined') return;
    const source = new EventSource('/api/notifications/stream');
    source.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as StreamEvent;
        setItems((prev) => {
          if (prev.some((n) => n.id === event.id)) return prev;
          return [
            {
              id: event.id,
              type: event.type,
              title: event.title,
              body: event.body,
              read: false,
              createdAt: event.createdAt,
            },
            ...prev,
          ].slice(0, 30);
        });
      } catch {
        // Malformed — ignore.
      }
    };
    return () => {
      source.close();
    };
  }, []);

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    await fetch('/api/notifications/mark-all-read', { method: 'POST' });
  }, []);

  const clear = useCallback(async () => {
    setItems([]);
    await fetch('/api/notifications/clear', { method: 'POST' });
  }, []);

  const unreadCount = items.reduce((n, item) => n + (item.read ? 0 : 1), 0);

  return { items, loading, unreadCount, markAllRead, clear };
}
