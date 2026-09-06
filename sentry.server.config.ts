import * as Sentry from '@sentry/nextjs';
import { sentryBeforeSend } from '@/lib/logger';

// Server-side Sentry init. Only sends when SENTRY_DSN is set; local dev
// stays silent. beforeSend hooks into our PHI scrubber + auto-tag with
// {orgId, requestId} from the request context.

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    // Error-only rollout: beforeSend does not scrub transactions or logs.
    // Re-enabling those channels requires its own payload/privacy review.
    tracesSampleRate: 0,
    enableLogs: false,
    beforeSend: (event) => sentryBeforeSend(event) as Sentry.ErrorEvent,
    // Explicit rather than inherited: this is what decides whether cookies,
    // headers and IP addresses ride along with every event. On a clinical
    // scheduler the answer is no, and it belongs in the config where a
    // reviewer can see it.
    sendDefaultPii: false,
    // Don't attach stack traces to breadcrumbs — they're noisy and
    // occasionally include argument values.
    attachStacktrace: false,
  });
}
