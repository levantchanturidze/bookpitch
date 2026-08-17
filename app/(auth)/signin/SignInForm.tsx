'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { signInAction, type SignInState } from './actions';
import StatusMessage from '@/components/ui/StatusMessage';
import Field from '@/components/ui/Field';

const initialState: SignInState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  );
}

export default function SignInForm() {
  const [state, formAction] = useActionState(signInAction, initialState);

  return (
    <form action={formAction} className="space-y-4">
      {/*
        P14-004: these were bare <label><span>+<input> pairs. The label was
        associated by nesting, which works, but nothing marked the field invalid
        when sign-in failed and nothing pointed the field at the reason. Field
        owns that wiring so it cannot be forgotten here or in the next form.

        The sign-in error is deliberately NOT attached to a single field: the
        server returns one enumeration-safe message for "wrong email" and "wrong
        password" alike, and pinning it to the email input would tell an attacker
        which half was wrong. It stays a form-level StatusMessage, and both
        fields are marked invalid so a screen-reader user knows the submission
        was rejected.
      */}
      <Field label="Email" invalid={!!state.error}>
        {({ id, ...aria }) => (
          <input
            {...aria}
            id={id}
            name="email"
            type="email"
            required
            autoComplete="email"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
          />
        )}
      </Field>
      <Field label="Password" invalid={!!state.error}>
        {({ id, ...aria }) => (
          <input
            {...aria}
            id={id}
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
          />
        )}
      </Field>
      {state.error && <StatusMessage tone="error">{state.error}</StatusMessage>}
      <SubmitButton />
      <p className="pt-1 text-center text-xs text-slate-500">
        <a href="/reset" className="font-semibold text-slate-700 hover:underline">
          Forgot password?
        </a>
      </p>
    </form>
  );
}
