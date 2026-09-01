import { Info, Search } from 'lucide-react';

// -----------------------------------------------------------------------------
// F16-008 — the states a fetched detail panel can be in.
//
// Extracted as presentational components for one reason: scripts/render-a11y-
// fixtures.tsx can render them to static HTML, so e2e/component-a11y.spec.ts
// exercises the real markup in six real browsers at real viewport sizes. Left
// inline they would only ever have been checked by reading them.
// -----------------------------------------------------------------------------

export function DetailLoading({ label }: { label: string }) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center text-slate-500"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div
        className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-slate-500"
        aria-hidden="true"
      />
      <p className="text-xs">Loading {label} record…</p>
    </div>
  );
}

export function DetailError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center px-4 text-center text-slate-600"
      role="alert"
    >
      <Info className="mb-2 h-10 w-10 stroke-1 text-rose-400" aria-hidden="true" />
      <p className="mb-3 max-w-xs text-xs">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
      >
        Try again
      </button>
    </div>
  );
}

export function DetailEmpty({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 text-center text-slate-600">
      <Info className="mb-2 h-10 w-10 stroke-1 text-slate-400" aria-hidden="true" />
      <p className="text-xs">Select a {label} to inspect details.</p>
    </div>
  );
}

export function ListEmpty({ searching, label }: { searching: boolean; label: string }) {
  return (
    <div className="flex flex-col items-center px-4 py-12 text-center text-slate-600">
      <Search className="mb-2 h-8 w-8 stroke-1 text-slate-400" aria-hidden="true" />
      <p className="text-xs">{searching ? 'No records match your search.' : `No ${label} yet.`}</p>
    </div>
  );
}
