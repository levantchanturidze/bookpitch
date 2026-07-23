import * as Sentry from '@sentry/nextjs';
import { sentryBeforeSend } from '@/lib/logger';

// Browser Sentry init. NEXT_PUBLIC_SENTRY_DSN is the public DSN Vercel/
// Next.js exposes to the client bundle; keep it separate from the server
// DSN so key rotation on one side doesn't take down the other.

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? 'production',
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.05),
    beforeSend: (event) => sentryBeforeSend(event) as Sentry.ErrorEvent,
    // Session Replay stays disabled — patient data is on screen; recording
    // it violates the "no PHI leaves the app" rule even with masking.
  });
}
