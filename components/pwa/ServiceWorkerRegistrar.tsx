'use client';

import { useEffect } from 'react';

// Registers the service worker in the browser.
// * PROD-ONLY: SW in dev = stale bundle footguns during hot reload.
// * SSR guard: `navigator` doesn't exist during server render.
// Renders nothing; this component is only mounted for its side effect.
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    // Fire-and-forget. Registration errors go to the console; nothing user-
    // visible is affected if it fails.
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[pwa] service worker registration failed:', err);
    });
  }, []);

  return null;
}
