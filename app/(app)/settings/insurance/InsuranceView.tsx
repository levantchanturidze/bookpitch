'use client';

import { useState, useTransition } from 'react';
import { Download } from 'lucide-react';
import StatusMessage from '@/components/ui/StatusMessage';

type CustomerBasic = {
  id: string;
  name: string;
  insurerName: string | null;
  insurancePolicyNumber: string | null;
};

export default function InsuranceView({
  insurers,
  customers,
}: {
  insurers: string[];
  customers: CustomerBasic[];
}) {
  const [customerList, setCustomerList] = useState(customers);
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
    <>
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
            <select
              value={insurer}
              onChange={(e) => setInsurer(e.target.value)}
              className={inputCls}
            >
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
          <StatusMessage tone="error" className="mt-3">
            {error}
          </StatusMessage>
        )}
      </div>

      <AddInsurerForm
        customers={customerList}
        onSaved={(updated) =>
          setCustomerList((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
        }
      />
    </>
  );
}

function AddInsurerForm({
  customers,
  onSaved,
}: {
  customers: CustomerBasic[];
  onSaved: (c: CustomerBasic) => void;
}) {
  const [customerId, setCustomerId] = useState('');
  const [insurerName, setInsurerName] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  const selected = customers.find((c) => c.id === customerId) ?? null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId) return;
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      const res = await fetch(`/api/customers/${customerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          insurerName: insurerName || null,
          insurancePolicyNumber: policyNumber || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Failed to save insurance info');
        return;
      }
      onSaved({
        id: customerId,
        name: selected?.name ?? '',
        insurerName: insurerName || null,
        insurancePolicyNumber: policyNumber || null,
      });
      setSuccess(true);
    });
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="mb-3 text-sm font-bold text-slate-800">Assign insurance to a patient</h2>
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <label className="block md:col-span-2">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">Patient</span>
          <select
            value={customerId}
            onChange={(e) => {
              const c = customers.find((x) => x.id === e.target.value);
              setCustomerId(e.target.value);
              setInsurerName(c?.insurerName ?? '');
              setPolicyNumber(c?.insurancePolicyNumber ?? '');
              setSuccess(false);
            }}
            required
            className={inputCls}
          >
            <option value="">— select patient —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.insurerName ? ` (${c.insurerName})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">Insurer</span>
          <input
            value={insurerName}
            onChange={(e) => setInsurerName(e.target.value)}
            placeholder="e.g. GPI"
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">Policy №</span>
          <input
            value={policyNumber}
            onChange={(e) => setPolicyNumber(e.target.value)}
            placeholder="e.g. GPI-001234"
            className={inputCls}
          />
        </label>
        <div className="flex items-end md:col-span-4">
          <button
            type="submit"
            disabled={isPending || !customerId}
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-40"
          >
            {isPending ? 'Saving…' : 'Save'}
          </button>
          {success && <p className="ml-3 text-xs text-emerald-700">Insurance info updated.</p>}
          {error && <p className="ml-3 text-xs text-rose-700">{error}</p>}
        </div>
      </form>
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none';
