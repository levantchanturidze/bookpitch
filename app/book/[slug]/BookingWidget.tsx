'use client';

import { useState } from 'react';
import StatusMessage from '@/components/ui/StatusMessage';

type PublicLocation = {
  organizationId: string;
  organizationName: string;
  currency: string;
  locationId: string;
  locationName: string;
  locationType: 'clinic' | 'salon';
  staff: Array<{ id: string; name: string; roleTitle: string }>;
  services: Array<{ id: string; name: string; price: number; durationMinutes: number }>;
};

// Minimal booking widget: pick service → staff → date+time → contact
// details → consent. No live-availability lookup (the GiST exclusion on
// the server enforces the constraint); we suggest a rolling 30-day
// window in half-hour steps and rely on the 409 to prompt for another
// slot. Fine for an MVP; tighten later with a slot-lookup endpoint.
export default function BookingWidget({
  location,
  slug,
}: {
  location: PublicLocation;
  slug: string;
}) {
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [when, setWhen] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true } | { ok: false; msg: string } | null>(null);

  // useState lazy initializer runs once on mount — exempt from purity constraints.
  const [minWhen] = useState(() => {
    const d = new Date(Date.now() + 30 * 60 * 1000);
    d.setUTCSeconds(0, 0);
    return d.toISOString().slice(0, 16);
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const res = await fetch('/api/public/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug,
        serviceId,
        staffId,
        startsAt: new Date(when).toISOString(),
        customerName,
        customerEmail: customerEmail || undefined,
        customerPhone: customerPhone || undefined,
        consented,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setResult({ ok: true });
    } else {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      const map: Record<string, string> = {
        slot_taken: 'That slot was just taken. Please pick another time.',
      };
      setResult({ ok: false, msg: map[err?.error ?? ''] ?? err?.error ?? 'Could not book.' });
    }
  }

  if (result?.ok) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-emerald-800">
        <h2 className="text-lg font-bold">Booking received</h2>
        <p className="mt-1 text-sm">
          {location.organizationName} will confirm shortly. Check your email or phone for a reminder
          before the appointment.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Service</span>
        <select
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
          required
          className={inputCls}
        >
          <option value="">— pick a service —</option>
          {location.services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.durationMinutes} min · {s.price} {location.currency}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Practitioner</span>
        <select
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          required
          className={inputCls}
        >
          <option value="">— pick a practitioner —</option>
          {location.staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.roleTitle}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Date & time (UTC)</span>
        <input
          type="datetime-local"
          value={when}
          min={minWhen}
          onChange={(e) => setWhen(e.target.value)}
          required
          className={inputCls}
        />
      </label>

      <div className="border-t border-slate-100 pt-4">
        <p className="mb-2 text-xs font-semibold text-slate-500">Your contact</p>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">Full name</span>
          <input
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            required
            className={inputCls}
          />
        </label>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-600">Email</span>
            <input
              type="email"
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-600">Phone</span>
            <input
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          Provide at least one — we need to reach you if the appointment shifts.
        </p>
      </div>

      <label className="flex items-start gap-2 border-t border-slate-100 pt-4 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={consented}
          onChange={(e) => setConsented(e.target.checked)}
          required
          className="mt-0.5"
        />
        <span>
          I agree to {location.organizationName} storing my contact details for this appointment. I
          can request a copy or deletion at any time.
        </span>
      </label>

      {result && !result.ok && <StatusMessage tone="error">{result.msg}</StatusMessage>}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ? 'Booking…' : 'Book appointment'}
      </button>
    </form>
  );
}

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none';
