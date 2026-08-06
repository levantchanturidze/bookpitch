'use client';

import { useState } from 'react';
import type { Plan, PlanId } from '@/lib/billing/plans';

export default function BillingView({
  plans,
  currentPlanId,
  planStatus,
}: {
  plans: Plan[];
  currentPlanId: PlanId;
  planStatus: string;
}) {
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upgrade(planId: PlanId) {
    setError(null);
    setBusy(planId);
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: planId }),
    });
    setBusy(null);
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(err?.error ?? 'Could not start checkout.');
      return;
    }
    const { url } = (await res.json()) as { url: string };
    window.location.assign(url);
  }

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {plans.map((p) => {
          const isCurrent = p.id === currentPlanId;
          return (
            <div
              key={p.id}
              className={`rounded-2xl border p-5 ${
                isCurrent ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-base font-extrabold">{p.name}</h2>
                <div className="font-mono text-sm">
                  {p.monthlyPriceGel === 0 ? 'Free' : `${p.monthlyPriceGel} ₾/mo`}
                </div>
              </div>
              <ul className="mt-4 space-y-1 text-xs">
                <li>{p.entitlements.maxStaff} staff seats</li>
                <li>{p.entitlements.maxMonthlyAssistantCalls} assistant calls / month</li>
                <li>SMS reminders: {p.entitlements.smsRemindersEnabled ? 'yes' : 'no'}</li>
                <li>Analytics: {p.entitlements.analyticsEnabled ? 'yes' : 'no'}</li>
              </ul>
              <div className="mt-4">
                {isCurrent ? (
                  <span className="inline-block rounded-md bg-white/10 px-2 py-1 text-[10px] tracking-widest uppercase">
                    Current · {planStatus}
                  </span>
                ) : p.id === 'free' ? (
                  <span className="text-[11px] text-slate-500">
                    Cancel from Stripe portal to downgrade.
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => upgrade(p.id)}
                    disabled={busy !== null}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {busy === p.id ? 'Redirecting…' : 'Upgrade'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
