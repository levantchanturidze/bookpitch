'use client';

import { useState, useTransition } from 'react';
import { Check, Info } from 'lucide-react';

type Toggles = {
  providerFinancialReports: boolean;
  providerClinicalNotesOthers: boolean;
  frontdeskClientFullHistory: boolean;
  frontdeskDiscountCeiling: number;
};

const ROWS: Array<{
  key: keyof Toggles;
  label: string;
  spec: string;
  kind: 'bool' | 'number';
}> = [
  {
    key: 'providerFinancialReports',
    label: 'Providers can see financial reports',
    spec: 'Default OFF. When enabled, providers pass can(ctx, report.financial:org).',
    kind: 'bool',
  },
  {
    key: 'providerClinicalNotesOthers',
    label: "Providers can read other clinicians' notes",
    spec: "Default OFF (privacy default). When enabled, providers pass can(ctx, clinical_note.read:any).",
    kind: 'bool',
  },
  {
    key: 'frontdeskClientFullHistory',
    label: 'Front-desk can see full client history',
    spec: 'Default OFF (name + contact only). When enabled, front-desk passes can(ctx, client.read:full).',
    kind: 'bool',
  },
  {
    key: 'frontdeskDiscountCeiling',
    label: 'Front-desk discount ceiling',
    spec: 'Maximum discount amount front-desk can apply at checkout. Enforced server-side by lib/payments/service.ts. Default 0 (no discretion).',
    kind: 'number',
  },
];

export default function PermissionsPanel({ initial }: { initial: Toggles }) {
  const [state, setState] = useState<Toggles>(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    setError(null); setSaved(false);
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/toggles', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state),
        });
        if (!res.ok) throw new Error(await res.text());
        setSaved(true);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  return (
    <section className="space-y-6">
      <div>
        <h3 className="text-sm font-bold text-slate-800">Permissions</h3>
        <p className="mt-1 max-w-2xl text-xs text-slate-500">
          Per-organization policy toggles. These change what specific roles
          can retrieve from the API — not just what the UI hides. Enable
          with care; some flags have compliance implications (medical
          record access, discount discretion).
        </p>
      </div>

      {error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      )}
      {saved && (
        <p className="flex items-center gap-1 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          <Check className="h-3 w-3" /> Saved. Changes take effect within 30 seconds.
        </p>
      )}

      <div className="space-y-3">
        {ROWS.map((row) => (
          <div key={row.key} className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <p className="text-sm font-semibold text-slate-800">{row.label}</p>
                <p className="mt-1 flex items-start gap-1 text-xs text-slate-500">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{row.spec}</span>
                </p>
              </div>
              <div className="shrink-0">
                {row.kind === 'bool' ? (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={state[row.key] as boolean}
                      onChange={(e) => setState({ ...state, [row.key]: e.target.checked })}
                    />
                    <span className={state[row.key] ? 'font-bold text-emerald-700' : 'text-slate-500'}>
                      {state[row.key] ? 'ENABLED' : 'DISABLED'}
                    </span>
                  </label>
                ) : (
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={state[row.key] as number}
                    onChange={(e) => setState({ ...state, [row.key]: Number(e.target.value) })}
                    className="w-24 rounded-md border border-slate-300 px-2 py-1 text-right font-mono text-sm"
                  />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-40"
      >
        {pending ? 'Saving…' : 'Save changes'}
      </button>
    </section>
  );
}
