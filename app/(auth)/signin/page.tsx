import SignInForm from './SignInForm';

export const metadata = { title: 'Sign in · Bookpitch' };

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6">
          <h1 className="text-lg font-extrabold tracking-tight text-slate-900">Bookpitch</h1>
          <p className="mt-1 text-xs text-slate-500">Sign in to your operations portal.</p>
        </div>
        <SignInForm />
        <p className="mt-6 border-t border-slate-100 pt-4 font-mono text-[10px] text-slate-400">
          Dev credentials in .env.local · owner@bookpitch.dev / reception@bookpitch.dev
        </p>
      </div>
    </main>
  );
}
