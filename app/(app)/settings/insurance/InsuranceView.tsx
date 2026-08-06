'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';

export default function InsuranceView({ insurers }: { insurers: string[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  const [from, setFrom] = useState(monthStart.toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const [insurer, setInsurer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setError(null);
    setBusy(true);
    const qs = new URLSearchParams({ from, to });
    if (insurer) qs.set('insurer', insurer);
    const res = await fetch(`/api/insurance/export?${qs.toString()}`);
    setBusy(false);
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(err?.error ?? 'Export failed.');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = res.headers.get('content-disposition')?.match(/"(.+)"/)?.[1] ?? 'claims.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">Insurer</span>
          <select value={insurer} onChange={(e) => setInsurer(e.target.value)} className={inputCls}>
            <option value="">All insurers</option>
            {insurers.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            onClick={download}
            disabled={busy}
            className="w-full rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            <Download className="mr-1 inline h-3.5 w-3.5" />
            {busy ? 'Building…' : 'Download CSV'}
          </button>
        </div>
      </div>
      {error && (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      )}
      {insurers.length === 0 && (
        <p className="mt-3 text-xs text-slate-500">
          No insurers on file yet. Add{' '}
          <code className="rounded bg-slate-100 px-1">insurer_name</code> +{' '}
          <code className="rounded bg-slate-100 px-1">insurance_policy_number</code> to any customer
          record.
        </p>
      )}
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none';
