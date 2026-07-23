'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { signInAction, type SignInState } from './actions';

const initialState: SignInState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  );
}

export default function SignInForm() {
  const [state, formAction] = useActionState(signInAction, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Email</span>
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Password</span>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
        />
      </label>
      {state.error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{state.error}</p>
      )}
      <SubmitButton />
      <p className="pt-1 text-center text-xs text-slate-500">
        <a href="/reset" className="font-semibold text-slate-700 hover:underline">
          Forgot password?
        </a>
      </p>
    </form>
  );
}
