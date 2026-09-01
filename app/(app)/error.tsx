'use client';

/**
 * Error boundary for every page under the (app) layout.
 *
 * It used to also render an "Operational Access Lock" panel by dispatching on
 * `error.name === 'ForbiddenError'`. That branch was dead in the only build
 * that matters: Next.js strips the name and message from errors forwarded to
 * the client in production — see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md:106
 * — so `error.name` is always 'Error' there and a denied user got HTTP 500 and
 * the generic fallback below (P17-013, measured 2026-09-01 against
 * `next start`: MARKETING on /scheduler, /audit and /settings).
 *
 * Authorization now interrupts before it reaches here. lib/rbac/page-guard.ts
 * calls Next's `forbidden()`, which renders app/(app)/forbidden.tsx with a 403.
 * This boundary is back to what an error boundary is for: an actual failure.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // P14-008: this used to render `{error.message}` directly. Next.js redacts
  // *server* errors in production, but an error thrown in a client component
  // reaches the boundary with its real message intact — so a stray
  // `TypeError: Cannot read properties of undefined (reading 'organizationId')`
  // was user-facing text. Show a stable message instead, and surface only the
  // digest, which is the identifier support can correlate with a server log.
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center space-y-4 rounded-2xl border border-slate-100 bg-white p-12 py-20 text-center shadow-sm"
    >
      <h2 className="text-base font-extrabold text-slate-800">Something went wrong</h2>
      <p className="mx-auto max-w-sm text-xs leading-relaxed text-slate-500">
        We could not load this page. Your data has not been changed. Try again, and if it keeps
        happening, contact your organisation owner.
      </p>
      {error.digest && (
        <p className="font-mono text-[10px] text-slate-500">Reference: {error.digest}</p>
      )}
      <button
        onClick={reset}
        className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        Try again
      </button>
    </div>
  );
}
