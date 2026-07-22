'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
//
// Simple polling every 30s (spec: "adequate for this workload and
// dependency-free"). Pauses when the tab is hidden so we don't burn quota,
// and forces a refresh the moment the tab regains focus.
//
// Upgrade to SSE later if the workload proves it deserves it — the writer
// already inserts rows synchronously, so no server-side changes needed.
// -----------------------------------------------------------------------------

const POLL_MS = 30_000;

export function useNotifications() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch('/api/notifications', {
        cache: 'no-store',
        signal: ac.signal,
      });
      if (!res.ok) return;
      const body = (await res.json()) as { notifications: NotificationItem[] };
      // Merge server truth with local read-state so mark-all-read stays
      // visually applied between polls (the DB flag becomes authoritative
      // after the next mark-all-read POST + subsequent poll).
      setItems((prev) => {
        const readIds = new Set(prev.filter((n) => n.read).map((n) => n.id));
        return body.notifications.map((n) =>
          readIds.has(n.id) ? { ...n, read: true } : n,
        );
      });
    } catch {
      // Network blip / aborted — try again next tick.
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    fetchOnce();
    const timer = setInterval(() => {
      // Skip polls while the tab is hidden — saves DB roundtrips.
      if (document.visibilityState === 'visible') fetchOnce();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchOnce();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      abortRef.current?.abort();
    };
  }, [fetchOnce]);

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
