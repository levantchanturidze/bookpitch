import ResetForm from './ResetForm';

export const metadata = { title: 'Reset password · Bookpitch' };

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6">
          <h1 className="text-lg font-extrabold tracking-tight text-slate-900">
            Reset password
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            {token
              ? 'Choose a new password. All existing sessions for your account will be signed out.'
              : 'Enter your email and we’ll send a reset link if the address is on file.'}
          </p>
        </div>
        <ResetForm token={token ?? null} />
        <p className="mt-6 border-t border-slate-100 pt-4 text-center text-xs text-slate-500">
          <a href="/signin" className="font-semibold text-slate-700 hover:underline">
            Back to sign in
          </a>
        </p>
      </div>
    </main>
  );
}
