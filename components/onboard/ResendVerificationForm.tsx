'use client';

import { useState, useTransition } from 'react';

/**
 * Enumeration-safe resend form for onboard/pending, /expired, and /error pages.
 *
 * Always shows the same success message whether the email exists or not —
 * prevents an attacker from learning whether an address has a pending
 * registration ("does this email belong to someone who just signed up?").
 *
 * Calls POST /api/onboard/resend. The API returns 202 regardless of outcome.
 */
export default function ResendVerificationForm() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      await fetch('/api/onboard/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // Always show success — enumeration-safe: we never reveal whether the
      // email matched a pending registration or not.
      setSubmitted(true);
    });
  };

  if (submitted) {
    return (
      <p className="mt-6 rounded-md bg-teal-50 px-4 py-3 text-sm font-medium text-teal-700">
        If a pending registration exists for that address, a new link is on its way. Check your
        inbox and spam folder.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3 text-left">
      <label className="block text-xs font-bold tracking-wider text-slate-500 uppercase">
        Email address
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          placeholder="you@example.com"
          className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-teal-500 focus:outline-none"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 disabled:opacity-40"
      >
        {pending ? 'Sending…' : 'Resend verification email'}
      </button>
    </form>
  );
}
