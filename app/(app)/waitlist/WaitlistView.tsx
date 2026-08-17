'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';

type Row = {
  id: string;
  customerId: string;
  staffId: string | null;
  serviceId: string | null;
  preferredFrom: string;
  preferredTo: string;
  status: string;
  notes: string | null;
  createdAt: string;
};

type Named = { id: string; name: string };

export default function WaitlistView({
  rows,
  customers,
  staff,
  services,
}: {
  rows: Row[];
  customers: Named[];
  staff: Named[];
  services: Named[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const nameById = (list: Named[], id: string | null) =>
    id ? (list.find((x) => x.id === id)?.name ?? id.slice(0, 8)) : 'any';

  async function add(fd: FormData) {
    setBusy(true);
    await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: String(fd.get('customerId') ?? ''),
        staffId: fd.get('staffId') ? String(fd.get('staffId')) : undefined,
        serviceId: fd.get('serviceId') ? String(fd.get('serviceId')) : undefined,
        preferredFrom: new Date(String(fd.get('preferredFrom') ?? '')).toISOString(),
        preferredTo: new Date(String(fd.get('preferredTo') ?? '')).toISOString(),
        notes: fd.get('notes') ? String(fd.get('notes')) : undefined,
      }),
    });
    setBusy(false);
    router.refresh();
  }

  async function remove(id: string) {
    setBusy(true);
    await fetch(`/api/waitlist/${id}`, { method: 'DELETE' });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <form action={add} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
        <p className="text-xs font-semibold text-slate-500">Add a waitlist entry</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">Customer</span>
            <select name="customerId" required className={inputCls}>
              <option value="">— pick —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">Staff (any)</span>
            <select name="staffId" className={inputCls}>
              <option value="">Any staff</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">
              Service (any)
            </span>
            <select name="serviceId" className={inputCls}>
              <option value="">Any service</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">
              Preferred from (UTC)
            </span>
            <input type="datetime-local" name="preferredFrom" required className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">
              Preferred to (UTC)
            </span>
            <input type="datetime-local" name="preferredTo" required className={inputCls} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">Notes</span>
          <input name="notes" className={inputCls} />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Add to waitlist'}
        </button>
      </form>

      <div className="rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 p-4">
          <p className="text-xs font-semibold text-slate-500">Current waitlist ({rows.length})</p>
        </div>
        <div className="divide-y divide-slate-100">
          {rows.length === 0 && <p className="p-4 text-xs text-slate-500">No customers waiting.</p>}
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between p-3 text-xs">
              <div className="min-w-0">
                <p className="font-semibold text-slate-800">{nameById(customers, r.customerId)}</p>
                <p className="text-slate-500">
                  {nameById(staff, r.staffId)} · {nameById(services, r.serviceId)} ·{' '}
                  {r.preferredFrom.slice(0, 10)} → {r.preferredTo.slice(0, 10)}
                </p>
                {r.notes && <p className="mt-0.5 text-slate-500 italic">{r.notes}</p>}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    r.status === 'notified'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {r.status}
                </span>
                <button
                  type="button"
                  onClick={() => remove(r.id)}
                  disabled={busy}
                  className="rounded p-1 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                  aria-label="Remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none';
