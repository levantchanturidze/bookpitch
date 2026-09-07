import * as Sentry from '@sentry/nextjs';
// Pure scrubber only: lib/logger.ts pulls in node:async_hooks for the
// server request context, which cannot be bundled for the browser. There is
// no orgId/requestId to attach on this side anyway — those come from a
// server request scope that does not exist in a tab.
import { scrubSentryEvent } from '@/lib/scrub';

// Browser Sentry init. NEXT_PUBLIC_SENTRY_DSN is the public DSN Vercel/
// Next.js exposes to the client bundle; keep it separate from the server
// DSN so key rotation on one side doesn't take down the other.
//
// Loaded by instrumentation-client.ts. Before P17-007 nothing loaded this
// file at all — see the comment there.

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? 'production',
    // Initial rollout is error-only. Other telemetry does not pass through
    // beforeSend and requires its own privacy review before being enabled.
    tracesSampleRate: 0,
    enableLogs: false,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend: (event) => scrubSentryEvent(event),
    // Explicit rather than relying on the SDK default: this decides whether
    // cookies, headers and IP addresses ride along with every event. On a
    // clinical scheduler the answer is no, and it should be visible in the
    // config rather than inherited.
    sendDefaultPii: false,
    // Session Replay stays disabled — patient data is on screen; recording
    // it violates the "no PHI leaves the app" rule even with masking.
  });
}
