import * as Sentry from '@sentry/nextjs';
import { sentryBeforeSend } from '@/lib/logger';

// Edge runtime (middleware). Error-only telemetry, like the other runtimes.

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    // beforeSend covers errors, not transaction or log payloads.
    tracesSampleRate: 0,
    enableLogs: false,
    beforeSend: (event) => sentryBeforeSend(event) as Sentry.ErrorEvent,
    // Explicit rather than inherited: this is what decides whether cookies,
    // headers and IP addresses ride along with every event. On a clinical
    // scheduler the answer is no, and it belongs in the config where a
    // reviewer can see it.
    sendDefaultPii: false,
  });
}
