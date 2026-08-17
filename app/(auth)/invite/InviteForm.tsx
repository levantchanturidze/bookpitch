'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import StatusMessage from '@/components/ui/StatusMessage';

export default function InviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(fd: FormData) {
    setStatus('submitting');
    setError(null);
    const res = await fetch('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        password: String(fd.get('password') ?? ''),
        fullName: String(fd.get('fullName') ?? ''),
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      setStatus('error');
      setError(err?.error ?? 'Could not accept invitation.');
      return;
    }
    router.push('/signin');
  }

  return (
    <form action={submit} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Your full name</span>
        <input name="fullName" required className={inputCls} autoComplete="name" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Choose a password</span>
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className={inputCls}
        />
        <span className="mt-1 block text-[11px] text-slate-500">
          If your email already has a Bookpitch account, this is ignored.
        </span>
      </label>

      {error && <StatusMessage tone="error">{error}</StatusMessage>}

      <button
        type="submit"
        disabled={status === 'submitting'}
        className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'submitting' ? 'Joining…' : 'Join workspace'}
      </button>
    </form>
  );
}

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none';
