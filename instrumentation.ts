export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Sentry's Next.js integration exposes a `captureRequestError` we surface
// as `onRequestError`, the Next hook name. Both no-op when SENTRY_DSN
// isn't set.
export { captureRequestError as onRequestError } from '@sentry/nextjs';
