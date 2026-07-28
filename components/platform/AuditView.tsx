'use client';

import { useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';

type Row = {
  id: string;
  at: string;
  action: string;
  entity: string;
  entityId: string | null;
  organizationId: string | null;
  organizationName: string | null;
  actorEmail: string | null;
  actorName: string | null;
  onBehalfOfEmail: string | null;
  reason: string | null;
  impersonationSessionId: string | null;
  breakGlassSessionId: string | null;
  meta: unknown;
};

export default function AuditView({
  rows,
  maskPii,
  initial,
}: {
  rows: Row[];
  maskPii: boolean;
  initial: { actor: string; org: string; action: string; from: string; to: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [f, setF] = useState(initial);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (f.actor)  params.set('actor', f.actor);
    if (f.org)    params.set('org', f.org);
    if (f.action) params.set('action', f.action);
    if (f.from)   params.set('from', f.from);
    if (f.to)     params.set('to', f.to);
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Audit log</h2>
        {maskPii && (
          <span className="rounded-md bg-amber-950 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-amber-200">
            PII masked (SUPPORT_AGENT view)
          </span>
        )}
      </div>

      <form onSubmit={submit} className="grid grid-cols-1 gap-3 rounded-lg border border-slate-800 bg-slate-900 p-4 md:grid-cols-6">
        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Actor UUID
          <input value={f.actor} onChange={(e) => setF({ ...f, actor: e.target.value })}
                 className="mt-1 w-full rounded bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100" />
        </label>
        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Org UUID
          <input value={f.org} onChange={(e) => setF({ ...f, org: e.target.value })}
                 className="mt-1 w-full rounded bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100" />
        </label>
        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Action prefix
          <input value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}
                 className="mt-1 w-full rounded bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100" />
        </label>
        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          From
          <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })}
                 className="mt-1 w-full rounded bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100" />
        </label>
        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          To
          <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}
                 className="mt-1 w-full rounded bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100" />
        </label>
        <button type="submit"
                className="self-end rounded-md bg-slate-100 px-3 py-2 text-xs font-bold text-slate-900 hover:bg-white">
          Apply
        </button>
      </form>

      <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-800 bg-slate-950 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-2 py-2">When</th>
              <th className="px-2 py-2">Action</th>
              <th className="px-2 py-2">Actor</th>
              <th className="px-2 py-2">On behalf of</th>
              <th className="px-2 py-2">Org</th>
              <th className="px-2 py-2">Entity</th>
              <th className="px-2 py-2">Session tag</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 font-mono text-[11px]">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-2 py-1 text-slate-400">{r.at.slice(0, 19).replace('T', ' ')}</td>
                <td className="px-2 py-1">{r.action}</td>
                <td className="px-2 py-1 text-slate-300">{r.actorEmail ?? '—'}</td>
                <td className="px-2 py-1 text-slate-500">{r.onBehalfOfEmail ?? ''}</td>
                <td className="px-2 py-1 text-slate-300">{r.organizationName ?? r.organizationId ?? '—'}</td>
                <td className="px-2 py-1 text-slate-500">{r.entity}{r.entityId ? `:${r.entityId.slice(0, 8)}` : ''}</td>
                <td className="px-2 py-1 text-[10px]">
                  {r.impersonationSessionId && <span className="rounded bg-amber-950 px-1 py-0.5 text-amber-200">imp</span>}
                  {r.breakGlassSessionId && <span className="ml-1 rounded bg-red-950 px-1 py-0.5 text-red-200">bg</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
