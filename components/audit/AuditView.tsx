'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Download, ShieldCheck } from 'lucide-react';
import type { AuditRow } from '@/lib/audit-query';

const ACTIONS = ['', 'list', 'read', 'create', 'update', 'delete', 'history_add'];
const ENTITIES = ['', 'customer', 'appointment', 'payment', 'staff'];

type Props = {
  rows: AuditRow[];
  initial: {
    customer: string;
    actor: string;
    action: string;
    entity: string;
    from: string;
    to: string;
  };
};

export default function AuditView({ rows, initial }: Props) {
  const router = useRouter();
  const sp = useSearchParams();
  const [filters, setFilters] = useState(initial);

  const apply = () => {
    const params = new URLSearchParams(sp?.toString());
    for (const [k, v] of Object.entries(filters)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    router.push(`/audit?${params.toString()}`);
  };
  const reset = () => {
    setFilters({ customer: '', actor: '', action: '', entity: '', from: '', to: '' });
    router.push('/audit');
  };

  const set = <K extends keyof typeof filters>(k: K, v: (typeof filters)[K]) =>
    setFilters((prev) => ({ ...prev, [k]: v }));

  const exportUrl = () => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v) params.set(k, v);
    }
    return `/api/audit/export?${params.toString()}`;
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-6">
        <div className="rounded-xl bg-slate-100 p-3 text-slate-600">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-extrabold tracking-tight text-slate-900">Audit log</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Every read + write of health data is recorded here. Newest first, capped at 200.
          </p>
        </div>
        <a
          href={exportUrl()}
          download
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </a>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <FilterField label="Customer id">
            <input
              value={filters.customer}
              onChange={(e) => set('customer', e.target.value)}
              placeholder="uuid"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 font-mono text-[11px] text-slate-700"
            />
          </FilterField>
          <FilterField label="Actor user id">
            <input
              value={filters.actor}
              onChange={(e) => set('actor', e.target.value)}
              placeholder="uuid"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 font-mono text-[11px] text-slate-700"
            />
          </FilterField>
          <FilterField label="Action">
            <select
              value={filters.action}
              onChange={(e) => set('action', e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
            >
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a || 'any'}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Entity">
            <select
              value={filters.entity}
              onChange={(e) => set('entity', e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
            >
              {ENTITIES.map((e) => (
                <option key={e} value={e}>
                  {e || 'any'}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label="From">
            <input
              type="date"
              value={filters.from}
              onChange={(e) => set('from', e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
            />
          </FilterField>
          <FilterField label="To">
            <input
              type="date"
              value={filters.to}
              onChange={(e) => set('to', e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
            />
          </FilterField>
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            onClick={reset}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-50"
          >
            Reset
          </button>
          <button
            onClick={apply}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-slate-800"
          >
            Apply
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <header className="border-b border-slate-100 px-6 py-3">
          <h3 className="font-mono text-[10px] font-bold tracking-widest text-slate-500 uppercase">
            Events — {rows.length}
          </h3>
        </header>
        {rows.length === 0 ? (
          <p className="px-6 py-8 text-center text-xs text-slate-500">
            No audit events match these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-100 bg-slate-50 font-mono text-[10px] tracking-wider text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-6 py-2 font-medium">
                    When
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Actor
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Action
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Entity
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Target
                  </th>
                  <th scope="col" className="px-6 py-2 font-medium">
                    Meta
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-6 py-2 font-mono text-[11px] whitespace-nowrap text-slate-500">
                      {r.at.slice(0, 19).replace('T', ' ')}
                    </td>
                    <td className="px-2 py-2 text-[11px] text-slate-700">
                      {r.actorEmail ?? <span className="text-slate-500 italic">system</span>}
                    </td>
                    <td className="px-2 py-2 font-mono text-[11px]">{r.action}</td>
                    <td className="px-2 py-2 font-mono text-[11px] text-slate-600">{r.entity}</td>
                    <td className="px-2 py-2 text-[11px]">
                      {r.customerName ? (
                        <span className="text-slate-700">{r.customerName}</span>
                      ) : r.entityId ? (
                        <span className="font-mono text-[10px] text-slate-500">
                          {r.entityId.slice(0, 8)}
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-6 py-2 font-mono text-[10px] text-slate-500">
                      {r.meta ? JSON.stringify(r.meta) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[9px] font-bold tracking-wider text-slate-500 uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}
