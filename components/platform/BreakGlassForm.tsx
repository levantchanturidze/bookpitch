'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';

/**
 * Break-glass activation UI. SUPER_ADMIN only (enforced server-side).
 * If a session is already active, shows the "end session" control instead.
 */
export default function BreakGlassForm({
  activeSession,
}: {
  activeSession: { sessionId: string; expiresAt: Date; targetOrganizationId: string | null } | null;
}) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (activeSession) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-bold">Break-glass session already active</h2>
        <div className="rounded-lg border-2 border-red-500 bg-red-950 p-6">
          <div className="flex items-center gap-3">
            <ShieldAlert className="h-6 w-6 text-red-300" />
            <div>
              <p className="font-mono text-xs text-red-200">
                Session {activeSession.sessionId} · target:{' '}
                {activeSession.targetOrganizationId ?? '(platform-wide)'}
              </p>
              <p className="mt-1 font-mono text-xs text-red-300">
                Expires: {new Date(activeSession.expiresAt).toLocaleString()}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                await fetch('/api/platform/break-glass/end', { method: 'POST' });
                router.refresh();
              });
            }}
            className="mt-4 rounded-md bg-red-100 px-4 py-2 text-sm font-bold text-red-900 hover:bg-white disabled:opacity-40"
          >
            End session
          </button>
        </div>
      </div>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/platform/break-glass', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password,
            reason,
            ticketId,
            targetOrganizationId: target || null,
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        setPassword('');
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-red-300">Activate break-glass access</h2>
        <p className="mt-1 max-w-2xl text-xs text-slate-400">
          Every read during this session is written to the audit log with a break-glass tag. Session
          expires after 60 minutes. Alert email fires immediately. Use only when a
          customer-authorised access is required and impersonation isn&apos;t sufficient.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-500 bg-red-950 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <form
        onSubmit={submit}
        className="space-y-3 rounded-lg border-2 border-red-500 bg-slate-900 p-6"
      >
        <label className="block text-xs font-bold tracking-wider text-slate-500 uppercase">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="mt-1 w-full rounded bg-slate-950 px-2 py-2 text-sm text-slate-100"
          />
        </label>
        <label className="block text-xs font-bold tracking-wider text-slate-500 uppercase">
          Reason (min 5 chars)
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={5}
            rows={2}
            className="mt-1 w-full rounded bg-slate-950 px-2 py-2 text-sm text-slate-100"
          />
        </label>
        <label className="block text-xs font-bold tracking-wider text-slate-500 uppercase">
          Ticket ID
          <input
            value={ticketId}
            onChange={(e) => setTicketId(e.target.value)}
            required
            className="mt-1 w-full rounded bg-slate-950 px-2 py-2 font-mono text-sm text-slate-100"
          />
        </label>
        <label className="block text-xs font-bold tracking-wider text-slate-500 uppercase">
          Target organization ID (optional)
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="mt-1 w-full rounded bg-slate-950 px-2 py-2 font-mono text-sm text-slate-100"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-40"
        >
          {pending ? 'Verifying…' : 'Activate break-glass'}
        </button>
      </form>
    </div>
  );
}
