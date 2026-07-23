import * as Sentry from '@sentry/nextjs';
import { sentryBeforeSend } from '@/lib/logger';

// Server-side Sentry init. Only sends when SENTRY_DSN is set; local dev
// stays silent. beforeSend hooks into our PHI scrubber + auto-tag with
// {orgId, requestId} from the request context.

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.05),
    // Send at most one event per second per session; noisy repeats add
    // no signal.
    beforeSend: (event) => sentryBeforeSend(event) as Sentry.ErrorEvent,
    // Don't attach stack traces to breadcrumbs — they're noisy and
    // occasionally include argument values.
    attachStacktrace: false,
  });
}
