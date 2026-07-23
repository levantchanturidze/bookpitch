'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function SignupForm() {
  const router = useRouter();
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(fd: FormData) {
    setStatus('submitting');
    setError(null);
    const payload = {
      email: String(fd.get('email') ?? ''),
      password: String(fd.get('password') ?? ''),
      fullName: String(fd.get('fullName') ?? ''),
      orgName: String(fd.get('orgName') ?? ''),
      locationName: String(fd.get('locationName') ?? ''),
      locationType: String(fd.get('locationType') ?? 'clinic'),
    };
    const res = await fetch('/api/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      setStatus('error');
      setError(err?.error ?? 'Could not create workspace.');
      return;
    }
    // Send them to /signin — Auth.js Credentials flow logs them in from there.
    router.push(`/signin?email=${encodeURIComponent(payload.email)}`);
  }

  return (
    <form action={submit} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Your full name</span>
        <input name="fullName" required className={inputCls} autoComplete="name" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Email</span>
        <input name="email" type="email" required className={inputCls} autoComplete="email" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Password</span>
        <input
          name="password"
          type="password"
          required
          minLength={8}
          className={inputCls}
          autoComplete="new-password"
        />
      </label>
      <div className="border-t border-slate-100 pt-4">
        <p className="mb-3 text-xs font-semibold text-slate-500">Workspace</p>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">
            Organisation name
          </span>
          <input name="orgName" required className={inputCls} />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-600">Location name</span>
            <input name="locationName" defaultValue="Main location" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-600">Type</span>
            <select name="locationType" defaultValue="clinic" className={inputCls}>
              <option value="clinic">Clinic</option>
              <option value="salon">Salon</option>
            </select>
          </label>
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      )}

      <button
        type="submit"
        disabled={status === 'submitting'}
        className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'submitting' ? 'Creating…' : 'Create workspace'}
      </button>
    </form>
  );
}

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none';
