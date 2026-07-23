import InviteForm from './InviteForm';

export const metadata = { title: 'Accept invitation · Bookpitch' };

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6">
          <h1 className="text-lg font-extrabold tracking-tight text-slate-900">
            Accept invitation
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            {token
              ? 'Set up your account to join the workspace. Existing accounts skip the password step.'
              : 'This link is missing its token. Ask your admin to resend the invitation.'}
          </p>
        </div>
        {token && <InviteForm token={token} />}
        <p className="mt-6 border-t border-slate-100 pt-4 text-center text-xs text-slate-500">
          <a href="/signin" className="font-semibold text-slate-700 hover:underline">
            Already signed up? Sign in
          </a>
        </p>
      </div>
    </main>
  );
}
