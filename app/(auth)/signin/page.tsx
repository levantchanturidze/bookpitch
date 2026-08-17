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
        {/*
          P14-011: this hint used to render unconditionally and was live on
          production, advertising two valid account addresses
          (owner@… / reception@…) to anyone loading /signin. That hands an
          attacker a confirmed user list and undercuts the enumeration-safe
          responses the rest of the auth surface is careful to return.

          It is genuinely useful in local development, so it is kept — behind
          an explicit non-production check evaluated on the server at render
          time. `NODE_ENV` is 'production' in every deployed environment,
          including Vercel Preview.
        */}
        {process.env.NODE_ENV !== 'production' && (
          <p className="mt-6 border-t border-slate-100 pt-4 font-mono text-[10px] text-slate-500">
            Dev credentials in .env.local · owner@bookpitch.dev / reception@bookpitch.dev
          </p>
        )}
      </div>
    </main>
  );
}
