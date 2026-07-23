'use client';

import { useState } from 'react';

export default function ResetForm({ token }: { token: string | null }) {
  const [status, setStatus] = useState<'idle' | 'submitting' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function submitRequest(fd: FormData) {
    setStatus('submitting');
    const email = String(fd.get('email') ?? '');
    const res = await fetch('/api/auth/reset/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (res.ok) {
      setStatus('ok');
      setMessage('If that address is on file, a reset link is on its way. Check your inbox.');
    } else {
      setStatus('error');
      setMessage('Something went wrong. Try again in a moment.');
    }
  }

  async function submitConsume(fd: FormData) {
    setStatus('submitting');
    const newPassword = String(fd.get('newPassword') ?? '');
    const res = await fetch('/api/auth/reset/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    });
    if (res.ok) {
      setStatus('ok');
      setMessage('Password updated. You can sign in with the new password.');
    } else {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      setStatus('error');
      setMessage(err?.error ?? 'Reset failed. Try requesting a fresh link.');
    }
  }

  return (
    <form
      action={token ? submitConsume : submitRequest}
      className="space-y-4"
    >
      {!token && (
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
      )}
      {token && (
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">New password</span>
          <input
            name="newPassword"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
          />
        </label>
      )}

      {message && (
        <p
          className={
            status === 'ok'
              ? 'rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700'
              : 'rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700'
          }
        >
          {message}
        </p>
      )}

      <button
        type="submit"
        disabled={status === 'submitting'}
        className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'submitting'
          ? 'Working…'
          : token
            ? 'Set new password'
            : 'Send reset link'}
      </button>
    </form>
  );
}
