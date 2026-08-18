import SignupForm from './SignupForm';
import LegalFooter from '@/components/legal/LegalFooter';

export const metadata = { title: 'Create account · Bookpitch' };

export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6">
          <h1 className="text-lg font-extrabold tracking-tight text-slate-900">
            Create your Bookpitch workspace
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            You&apos;ll be the owner. Add staff and a full schedule after signing in.
          </p>
        </div>
        <SignupForm />
        <LegalFooter notice />
        <p className="mt-4 text-center text-xs text-slate-500">
          Already have an account?{' '}
          <a href="/signin" className="font-semibold text-slate-700 hover:underline">
            Sign in
          </a>
        </p>
      </div>
    </main>
  );
}
