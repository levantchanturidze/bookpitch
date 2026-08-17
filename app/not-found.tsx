import Link from 'next/link';
import { Compass } from 'lucide-react';

export const metadata = {
  title: 'Page not found · Bookpitch',
  robots: { index: false, follow: false },
};

/**
 * P14-009: there was no not-found boundary at all, so a mistyped URL — or any
 * `notFound()` call — rendered Next.js's stock black-on-white "404 | This page
 * could not be found", outside the design system and with no way back into the
 * product except the browser's back button.
 *
 * Deliberately routed through `/` rather than `/dashboard`: an unauthenticated
 * visitor hitting a bad URL should not be bounced into a sign-in redirect, and
 * the proxy already sends authenticated users onward from the landing page.
 */
export default function NotFound() {
  return (
    <main
      id="main"
      className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-16"
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
        <div className="mx-auto mb-4 w-fit rounded-full bg-slate-100 p-4 text-slate-500">
          <Compass className="h-8 w-8 stroke-[2.5]" aria-hidden="true" />
        </div>
        <h1 className="text-lg font-extrabold tracking-tight text-slate-900">Page not found</h1>
        <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-slate-500">
          The page you are looking for does not exist, or you may not have access to it. Check the
          address, or head back and try again.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Link
            href="/"
            className="rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Go to Bookpitch
          </Link>
          <Link
            href="/signin"
            className="rounded-lg border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
