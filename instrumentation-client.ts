// -----------------------------------------------------------------------------
// P17-007 — browser-side Sentry initialisation.
//
// sentry.client.config.ts has existed since Phase 8 and has never run. Two
// separate reasons, and the second one is the interesting one:
//
//  1. Nothing imported it. The @sentry/nextjs SDK discovers that filename only
//     from its own webpack config (build/cjs/config/webpack.js looks for
//     "sentry.client.config.ts"), and that path is reached only when
//     next.config.ts is wrapped in `withSentryConfig`. It is not. So the file
//     was never in any bundle.
//
//  2. It could not have been imported. It pulled `sentryBeforeSend` from
//     lib/logger.ts, whose first line is
//     `import { AsyncLocalStorage } from 'node:async_hooks'`. Wiring it up
//     failed the build outright:
//         the chunking context (unknown) does not support external modules
//         (request: node:async_hooks)
//     Anyone who had added withSentryConfig would have hit this immediately.
//     lib/scrub.ts now holds the pure half so the browser scrubs events with
//     exactly the same rules the server uses.
//
// `instrumentation-client.ts` is the framework's own convention (Next 15.3+,
// documented at node_modules/next/dist/docs/01-app/03-api-reference/
// 03-file-conventions/instrumentation-client.md). It runs after the document
// loads and before React hydration, and it works under Turbopack — where the
// SDK's webpack discovery does not apply at all.
//
// ---------------------------------------------------------------------------
// Why the import is dynamic and guarded, rather than a plain top-level import.
//
// Measured on this tree: a static `import './sentry.client.config'` adds
// 63,243 bytes gzipped to the shared client JS — 458,764 with, 395,521
// without, about 16% more JavaScript for every visitor including the public
// booking widget. It costs that whether or not a DSN is configured, and today
// no DSN is configured, so it would be 61 KB of dead weight on every page load.
//
// NEXT_PUBLIC_SENTRY_DSN is inlined at build time, so this condition is a
// constant the bundler can fold: with no DSN the SDK is not on the critical
// path at all.
//
// The cost of doing it this way is real but small. Next's own docs note that
// async work started here is fire-and-forget and may resolve after hydration
// begins, so an error thrown in the first few milliseconds can be missed.
// That is worth 61 KB on every page: the errors this exists to catch are
// overwhelmingly interaction-driven and land long after hydration.
// ---------------------------------------------------------------------------
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  void import('./sentry.client.config');
}
