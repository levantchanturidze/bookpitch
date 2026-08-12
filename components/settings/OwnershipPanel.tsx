'use client';

import { useState, useTransition } from 'react';

type Incoming = {
  id: string;
  organizationId: string;
  organizationName: string;
  fromEmail: string;
  fromName: string | null;
  createdAt: string;
  expiresAt: string;
};

type Outgoing = {
  id: string;
  organizationId: string;
  organizationName: string;
  toEmail: string;
  toName: string | null;
  createdAt: string;
  expiresAt: string;
};

export default function OwnershipPanel({
  incoming,
  outgoing,
}: {
  incoming: Incoming[];
  outgoing: Outgoing[];
}) {
  const [incomingList, setIncomingList] = useState(incoming);
  const [outgoingList, setOutgoingList] = useState(outgoing);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const accept = (id: string) => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/ownership-transfer/${id}/accept`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Failed to accept transfer');
        return;
      }
      setIncomingList((l) => l.filter((t) => t.id !== id));
    });
  };

  const decline = (id: string) => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/ownership-transfer/${id}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'declined by nominee' }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Failed to decline transfer');
        return;
      }
      setIncomingList((l) => l.filter((t) => t.id !== id));
    });
  };

  const revoke = (id: string) => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/ownership-transfer/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Failed to revoke transfer');
        return;
      }
      setOutgoingList((l) => l.filter((t) => t.id !== id));
    });
  };

  const hasAnything = incomingList.length > 0 || outgoingList.length > 0;

  return (
    <section className="space-y-6">
      <h3 className="text-sm font-bold text-slate-800">Ownership Transfer</h3>

      {error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      )}

      {!hasAnything && (
        <p className="rounded-2xl border border-slate-200 bg-white px-6 py-8 text-center text-xs text-slate-500">
          No pending ownership transfers.
        </p>
      )}

      {incomingList.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">
            Incoming — you have been nominated
          </p>
          {incomingList.map((t) => (
            <div
              key={t.id}
              className="flex items-start justify-between gap-4 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4"
            >
              <div className="space-y-0.5 text-xs text-amber-900">
                <p className="font-bold">{t.organizationName}</p>
                <p>
                  Nominated by{' '}
                  <span className="font-mono">{t.fromName ?? t.fromEmail}</span>
                </p>
                <p className="font-mono text-[10px] text-amber-700">
                  Expires {new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(t.expiresAt))}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => decline(t.id)}
                  disabled={isPending}
                  className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-40"
                >
                  Decline
                </button>
                <button
                  onClick={() => accept(t.id)}
                  disabled={isPending}
                  className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-800 disabled:opacity-40"
                >
                  Accept
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {outgoingList.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">
            Outgoing — awaiting acceptance
          </p>
          {outgoingList.map((t) => (
            <div
              key={t.id}
              className="flex items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4"
            >
              <div className="space-y-0.5 text-xs text-slate-700">
                <p className="font-bold">{t.organizationName}</p>
                <p>
                  Nominated <span className="font-mono">{t.toName ?? t.toEmail}</span>
                </p>
                <p className="font-mono text-[10px] text-slate-500">
                  Expires {new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(t.expiresAt))}
                </p>
              </div>
              <button
                onClick={() => {
                  if (confirm('Revoke this nomination?')) revoke(t.id);
                }}
                disabled={isPending}
                className="shrink-0 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-40"
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
