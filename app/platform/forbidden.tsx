import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';

/**
 * P17-013 — authorization boundary for the platform plane.
 *
 * app/platform/layout.tsx still redirects a caller with no
 * `platform.analytics.read` back to '/', because an org-plane user reaching
 * /platform is a wrong-plane routing problem, not a denial they can act on.
 * This boundary is for the other case: a platform role that holds the plane
 * but not the specific permission — PLATFORM_SUPPORT opening
 * /platform/orgs/new, which needs `platform.org.create`. That used to be a
 * 500.
 */
export default function PlatformForbidden() {
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-lg flex-col items-center justify-center space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-12 py-20 text-center"
    >
      <div className="rounded-full bg-rose-500/10 p-4 text-rose-400">
        <ShieldAlert className="h-8 w-8 stroke-[2.5]" aria-hidden="true" />
      </div>
      <div>
        <h2 className="text-base font-extrabold text-slate-100">Platform access lock</h2>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-400">
          Your platform role does not carry the permission this screen requires. Ask a platform
          owner to grant it, or use a role that already holds it.
        </p>
      </div>
      <Link
        href="/platform"
        className="rounded-lg bg-slate-100 px-4 py-2 text-xs font-bold text-slate-900 hover:bg-white focus-visible:ring-2 focus-visible:ring-slate-100 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 focus-visible:outline-none"
      >
        Back to the platform console
      </Link>
    </div>
  );
}
