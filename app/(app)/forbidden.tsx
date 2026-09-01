import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';

/**
 * P17-013 — the authorization boundary for every page under the (app) layout.
 *
 * Next renders this when a server component calls `forbidden()`
 * (lib/rbac/page-guard.ts) and answers 403. It replaces the branch in
 * app/(app)/error.tsx that dispatched on `error.name === 'ForbiddenError'` —
 * a name that does not survive to the client in a production build, so that
 * branch never ran where users are. A denied MARKETING account opening
 * /scheduler got HTTP 500 and "Something went wrong" instead.
 *
 * A server component, so it renders inside the response rather than after
 * hydration, and it is what sets the status code.
 *
 * Deliberately says nothing about which permission was missing, which role
 * holds it, or whether the underlying record exists. The refusal is the whole
 * message; the detail lives in the `rbac.enforce_deny` server log.
 */
export default function AppForbidden() {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center space-y-4 rounded-2xl border border-slate-100 bg-white p-12 py-20 text-center shadow-sm"
    >
      <div className="rounded-full bg-rose-50 p-4 text-rose-600">
        <ShieldAlert className="h-8 w-8 stroke-[2.5]" aria-hidden="true" />
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
      <Link
        href="/"
        className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        Back to your home page
      </Link>
    </div>
  );
}
