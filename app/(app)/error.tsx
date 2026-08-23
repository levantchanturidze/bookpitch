'use client';

import { ShieldAlert } from 'lucide-react';

/**
 * Error boundary for every page under the (app) layout. In particular,
 * turns ForbiddenError thrown by requireRole() into a friendly "Access
 * Locked" panel matching the prototype's design.
 *
 * Error class identity doesn't survive the server/client boundary, so we
 * dispatch on `error.name` (set in lib/auth.ts).
 *
 * P17-013 — KNOWN GAP, measured 2026-08-23, not fixed in Phase 17.
 *
 * `error.name` is 'Error' in a production build, so `isForbidden` is always
 * false there and this panel never renders in production. Next.js strips the
 * name and message from errors forwarded to the client to avoid leaking server
 * detail — see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md:106.
 * Only `digest` survives, and it is a hash, not a type.
 *
 * Observed against `next start`: MARKETING opening /scheduler gets HTTP 500,
 * `rbac.enforce_deny` in the server log, and the generic "Something went
 * wrong" fallback below. The refusal is correct and no tenant data leaks; the
 * user is simply told the wrong thing.
 *
 * The fix is not a patch here — the client cannot recover the error type. It is
 * Next's `forbidden()` plus a `forbidden.tsx` boundary, which needs
 * `experimental.authInterrupts` and a change at every guard callsite. That is
 * a redesign, not a stabilization change, so it is recorded for Phase 18 in
 * docs/phase-17-stabilization-ledger.md rather than rushed in at the end of a
 * phase.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isForbidden = error.name === 'ForbiddenError';

  if (isForbidden) {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 rounded-2xl border border-slate-100 bg-white p-12 py-20 text-center shadow-sm">
        <div className="rounded-full bg-rose-50 p-4 text-rose-600">
          <ShieldAlert className="h-8 w-8 stroke-[2.5]" />
        </div>
        <div>
          <h2 className="text-base font-extrabold text-slate-800">Operational Access Lock</h2>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
            Your credential role is restricted from this module for compliance reasons. Contact the
            operations owner if you need elevated access.
          </p>
        </div>
        <div className="max-w-md rounded-xl border border-slate-100 bg-slate-50 p-3.5 font-mono text-[10px] text-slate-500">
          Role-based access control (RBAC) blocks this route. Switch to a different login to view.
        </div>
      </div>
    );
  }

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
