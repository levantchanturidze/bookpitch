'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Holder = {
  userId: string;
  email: string;
  fullName: string | null;
  roleKey: string;
  rolePlane: string;
  assignedAt: string | null;
};

const PLATFORM_ROLE_KEYS = [
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'SUPPORT_AGENT',
  'BILLING_MANAGER',
] as const;

export default function PlatformRolesPanel({
  holders,
  canAssign,
}: {
  holders: Holder[];
  canAssign: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState<(typeof PLATFORM_ROLE_KEYS)[number]>('SUPPORT_AGENT');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(revoke: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/platform/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          roleKey: revoke ? null : roleKey,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = await res.json();
      setMsg({
        ok: true,
        text: `${revoke ? 'Revoked' : 'Assigned'} — previous role: ${j.previousRoleKey ?? '(none)'}`,
      });
      setEmail('');
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="mb-4 text-lg font-bold">Platform roles</h2>

      <div className="mb-6 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-800 bg-slate-950 font-mono text-[10px] tracking-wider text-slate-500 uppercase">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Email
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Name
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Role
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Assigned
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {holders.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                  No platform-role users assigned.
                </td>
              </tr>
            )}
            {holders.map((h) => (
              <tr key={h.userId} className="hover:bg-slate-800/40">
                <td className="px-4 py-2 font-mono text-slate-200">{h.email}</td>
                <td className="px-2 py-2 text-slate-400">{h.fullName ?? '—'}</td>
                <td className="px-2 py-2">
                  <span className="rounded-md bg-purple-900 px-1.5 py-0.5 font-mono text-[10px] text-purple-200 uppercase">
                    {h.roleKey}
                  </span>
                </td>
                <td className="px-4 py-2 font-mono text-[10px] text-slate-500">
                  {h.assignedAt?.slice(0, 10) ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canAssign ? (
        <div className="max-w-lg rounded-lg border border-slate-800 bg-slate-900 p-5">
          <h3 className="mb-3 text-sm font-bold">Assign / revoke platform role</h3>
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-300">User email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                placeholder="user@example.com"
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                User must already exist. Bootstrap SUPER_ADMINs via{' '}
                <code>scripts/create-platform-user.ts</code>.
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-300">Role</span>
              <select
                value={roleKey}
                onChange={(e) => setRoleKey(e.target.value as never)}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              >
                {PLATFORM_ROLE_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => submit(false)}
                disabled={busy || !email.trim()}
                className="rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? '…' : 'Assign role'}
              </button>
              <button
                onClick={() => submit(true)}
                disabled={busy || !email.trim()}
                className="rounded-md bg-red-700 px-3 py-2 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50"
              >
                Revoke platform role
              </button>
            </div>
            {msg && (
              <div
                className={`mt-2 rounded-md p-2 text-xs ${msg.ok ? 'bg-emerald-950 text-emerald-200' : 'bg-red-950 text-red-200'}`}
              >
                {msg.text}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="max-w-lg rounded-lg border border-amber-800 bg-amber-950 p-4 text-xs text-amber-200">
          Only SUPER_ADMIN can assign or revoke platform roles.
        </div>
      )}
    </div>
  );
}
