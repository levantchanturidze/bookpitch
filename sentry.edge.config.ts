import * as Sentry from '@sentry/nextjs';
import { sentryBeforeSend } from '@/lib/logger';

// Edge runtime (middleware). Slimmer init — no attachStacktrace, low
// tracesSampleRate because middleware fires on every request.

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_EDGE_TRACES_SAMPLE_RATE ?? 0.01),
    beforeSend: (event) => sentryBeforeSend(event) as Sentry.ErrorEvent,
  });
}
