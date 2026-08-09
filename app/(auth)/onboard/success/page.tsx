export const metadata = { title: 'Account verified · Bookpitch' };

export default function OnboardSuccessPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-teal-50">
          <svg className="h-6 w-6 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-lg font-extrabold tracking-tight text-slate-900">Email verified</h1>
        <p className="mt-2 text-sm text-slate-500">
          Your Bookpitch workspace is ready. Sign in to get started.
        </p>
        <a
          href="/signin"
          className="mt-6 inline-block rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800"
        >
          Sign in
        </a>
      </div>
    </main>
  );
}
