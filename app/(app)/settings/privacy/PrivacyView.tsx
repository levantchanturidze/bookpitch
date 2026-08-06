'use client';

import { useState } from 'react';
import { Download, ShieldOff, AlertTriangle } from 'lucide-react';

type DsrRow = {
  id: string;
  action: 'export' | 'anonymize';
  entityId: string | null;
  customerName: string | null;
  actorEmail: string | null;
  at: string;
  slaDueAt: string;
  slaOverdue: boolean;
};

type Customer = { id: string; name: string };

export default function PrivacyView({
  rows,
  customers,
}: {
  rows: DsrRow[];
  customers: Customer[];
}) {
  const [customerId, setCustomerId] = useState('');
  const [busy, setBusy] = useState<null | 'export' | 'anonymize'>(null);
  const [msg, setMsg] = useState<{ level: 'ok' | 'err'; text: string } | null>(null);

  async function exportOne() {
    if (!customerId) return;
    setMsg(null);
    setBusy('export');
    const res = await fetch(`/api/customers/${customerId}/export`, { method: 'POST' });
    setBusy(null);
    if (!res.ok) {
      setMsg({ level: 'err', text: 'Export failed.' });
      return;
    }
    // Kick off a download from the response.
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `customer-${customerId}-export.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setMsg({ level: 'ok', text: 'Export downloaded.' });
  }

  async function anonymizeOne() {
    if (!customerId) return;
    if (!confirm('This clears the customer’s PII (name/email/phone/DOB/notes). Continue?')) return;
    setMsg(null);
    setBusy('anonymize');
    const res = await fetch(`/api/customers/${customerId}/anonymize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'gdpr' }),
    });
    setBusy(null);
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      setMsg({ level: 'err', text: err?.error ?? 'Anonymize failed.' });
      return;
    }
    setMsg({ level: 'ok', text: 'Customer PII cleared. Row + appointments preserved.' });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <p className="mb-3 text-xs font-semibold text-slate-500">Run a DSR now</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="col-span-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm md:col-span-2"
          >
            <option value="">— pick a customer —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={exportOne}
              disabled={!customerId || busy !== null}
              className="flex-1 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              <Download className="mr-1 inline h-3.5 w-3.5" />
              {busy === 'export' ? 'Working…' : 'Export'}
            </button>
            <button
              type="button"
              onClick={anonymizeOne}
              disabled={!customerId || busy !== null}
              className="flex-1 rounded-lg bg-rose-600 px-3 py-2 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50"
            >
              <ShieldOff className="mr-1 inline h-3.5 w-3.5" />
              {busy === 'anonymize' ? 'Working…' : 'Delete'}
            </button>
          </div>
        </div>
        {msg && (
          <p
            className={`mt-3 rounded-lg px-3 py-2 text-xs ${
              msg.level === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
            }`}
          >
            {msg.text}
          </p>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 p-4">
          <p className="text-xs font-semibold text-slate-500">Recent DSR activity</p>
        </div>
        <div className="divide-y divide-slate-100">
          {rows.length === 0 && (
            <p className="p-4 text-xs text-slate-500">No DSR actions in the last 50 audit rows.</p>
          )}
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between p-3 text-xs">
              <div>
                <p className="font-semibold text-slate-800">
                  {r.action === 'export' ? 'Export' : 'Anonymize'}
                  {r.customerName ? ` · ${r.customerName}` : ''}
                </p>
                <p className="text-slate-500">
                  by {r.actorEmail ?? 'system'} ·{' '}
                  {new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')}
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono text-[11px] text-slate-500">
                  SLA due {new Date(r.slaDueAt).toISOString().slice(0, 10)}
                </p>
                {r.slaOverdue && (
                  <span className="mt-1 inline-flex items-center gap-1 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
                    <AlertTriangle className="h-3 w-3" /> overdue
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
