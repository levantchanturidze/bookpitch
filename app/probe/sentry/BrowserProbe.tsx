'use client';

import { useEffect, useState } from 'react';
import * as Sentry from '@sentry/nextjs';

// -----------------------------------------------------------------------------
// The browser half of the Sentry receipt probe.
//
// It must run in a real browser, in the deployed bundle, through the same
// client SDK a real user's error would take — that is the whole point. A
// captureException from Node proves nothing about NEXT_PUBLIC_SENTRY_DSN, the
// client transport, or whether browser source maps were uploaded.
//
// The outcome is written into the DOM (`#probe-status`) rather than logged,
// because the driver reading it is Playwright, and a console line is not a
// reliable signal to wait on.
// -----------------------------------------------------------------------------

class BookpitchBrowserProbeError extends Error {
  constructor(nonce: string) {
    super(`Bookpitch synthetic browser Sentry probe (${nonce}) — safe to resolve`);
    this.name = 'BookpitchBrowserProbeError';
  }
}

export default function BrowserProbe({
  nonce,
  release,
}: {
  nonce: string;
  release: string | null;
}) {
  const [status, setStatus] = useState<'pending' | 'ok' | 'no-client' | 'not-flushed'>('pending');
  const [eventId, setEventId] = useState<string>('');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // instrumentation-client.ts imports the SDK dynamically, so the client
      // may not exist yet on first paint. Wait for it rather than racing it —
      // and give up rather than hanging, because "the SDK never initialised"
      // is itself the finding.
      let client = Sentry.getClient();
      for (let i = 0; i < 50 && !client; i++) {
        await new Promise((r) => setTimeout(r, 100));
        client = Sentry.getClient();
      }
      if (cancelled) return;
      if (!client) {
        setStatus('no-client');
        return;
      }

      const id = Sentry.captureException(new BookpitchBrowserProbeError(nonce), {
        tags: {
          bookpitch_verification_nonce: nonce,
          bookpitch_runtime: 'browser',
          bookpitch_probe: 'true',
        },
        ...(release ? { extra: { release } } : {}),
      });
      const flushed = await Sentry.flush(8_000);
      if (cancelled) return;
      setEventId(id ?? '');
      setStatus(flushed ? 'ok' : 'not-flushed');
    })();

    return () => {
      cancelled = true;
    };
  }, [nonce, release]);

  return (
    <main style={{ fontFamily: 'monospace', padding: '2rem' }}>
      <h1>Sentry browser probe</h1>
      <p id="probe-status" data-status={status} data-event-id={eventId}>
        {status}
      </p>
      <p>
        This page deliberately reports one synthetic error to Sentry. It is reachable only with a
        short-lived server-issued token and only while the probe is enabled.
      </p>
    </main>
  );
}
