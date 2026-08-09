export const metadata = { title: 'Check your email · Bookpitch' };

export default function OnboardPendingPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-teal-50">
          <svg
            className="h-6 w-6 text-teal-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
        </div>
        <h1 className="text-lg font-extrabold tracking-tight text-slate-900">Check your inbox</h1>
        <p className="mt-2 text-sm text-slate-500">
          We sent a verification link to your email address. Click the link to activate your
          Bookpitch workspace. The link expires in 24 hours.
        </p>
        <p className="mt-4 text-xs text-slate-400">
          Didn&apos;t receive it? Check your spam folder, or{' '}
          <a href="/signup" className="font-semibold text-slate-600 hover:underline">
            sign up again
          </a>{' '}
          to resend.
        </p>
      </div>
    </main>
  );
}
