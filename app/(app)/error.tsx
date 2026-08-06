'use client';

import { ShieldAlert } from 'lucide-react';

/**
 * Error boundary for every page under the (app) layout. In particular,
 * turns ForbiddenError thrown by requireRole() into a friendly "Access
 * Locked" panel matching the prototype's design.
 *
 * Error class identity doesn't survive the server/client boundary, so we
 * dispatch on `error.name` (set in lib/auth.ts).
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
          <h3 className="text-base font-extrabold text-slate-800">Operational Access Lock</h3>
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

  return (
    <div className="flex flex-col items-center justify-center space-y-4 rounded-2xl border border-slate-100 bg-white p-12 py-20 text-center shadow-sm">
      <h3 className="text-base font-extrabold text-slate-800">Something went wrong</h3>
      <p className="mx-auto max-w-sm text-xs text-slate-500">{error.message}</p>
      <button
        onClick={reset}
        className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800"
      >
        Try again
      </button>
    </div>
  );
}
