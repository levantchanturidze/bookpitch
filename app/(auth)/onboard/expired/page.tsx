export const metadata = { title: 'Link expired · Bookpitch' };

export default function OnboardExpiredPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50">
          <svg
            className="h-6 w-6 text-amber-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <h1 className="text-lg font-extrabold tracking-tight text-slate-900">
          Link expired or invalid
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          Your verification link has expired or has already been used. Verification links are valid
          for 24 hours and can only be clicked once.
        </p>
        <a
          href="/signup"
          className="mt-6 inline-block rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800"
        >
          Request a new link
        </a>
        <p className="mt-4 text-xs text-slate-400">
          Already verified?{' '}
          <a href="/signin" className="font-semibold text-slate-600 hover:underline">
            Sign in
          </a>
        </p>
      </div>
    </main>
  );
}
