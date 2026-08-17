import { WifiOff } from 'lucide-react';

export const metadata = { title: 'Offline · Bookpitch' };

// Cached by the service worker at install time. Rendered when the browser
// is offline AND the requested route isn't already in cache. Intentionally
// static + minimal so it fits in the SW precache.
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-600">
          <WifiOff className="h-6 w-6 stroke-[2]" />
        </div>
        <h1 className="text-base font-extrabold text-slate-900">You&apos;re offline</h1>
        <p className="mt-2 text-xs text-slate-500">
          Your device isn&apos;t connected right now. The app will reconnect automatically as soon
          as your network comes back — bookings and payments always live on the server, so nothing
          gets lost.
        </p>
      </div>
    </main>
  );
}
