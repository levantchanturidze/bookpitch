'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type CreateResult = {
  organizationId: string;
  locationId: string;
  ownerInvitationUrl: string | null;
  ownerPromotedExistingUser: boolean;
};

export default function NewOrgForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [vertical, setVertical] = useState<'clinic' | 'salon' | 'fitness' | 'mixed' | ''>('');
  const [locationName, setLocationName] = useState('Main location');
  const [locationType, setLocationType] = useState<'clinic' | 'salon'>('clinic');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        vertical: vertical || null,
        locationName: locationName.trim(),
        locationType,
        ownerEmail: ownerEmail.trim() || null,
      };
      const res = await fetch('/api/platform/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as CreateResult;
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="max-w-xl">
        <h2 className="mb-4 text-lg font-bold">Organization created</h2>
        <div className="rounded-md border border-emerald-800 bg-emerald-950 p-4 text-sm">
          <p className="mb-2 font-mono text-xs text-emerald-300">id={result.organizationId}</p>
          {result.ownerPromotedExistingUser && (
            <p className="text-emerald-200">Existing user promoted to ORG_OWNER.</p>
          )}
          {result.ownerInvitationUrl && (
            <div className="mt-2">
              <p className="text-emerald-200">Owner invitation link (copy now, one-time):</p>
              <p className="mt-1 rounded bg-slate-900 p-2 font-mono text-[11px] break-all text-emerald-100">
                {result.ownerInvitationUrl}
              </p>
              <p className="mt-2 text-[11px] text-emerald-400">
                Send this to the owner. They set their own password via the link. Spec §9 rule 4:
                admins never set passwords directly.
              </p>
            </div>
          )}
          {!result.ownerInvitationUrl && !result.ownerPromotedExistingUser && (
            <p className="text-amber-200">
              No owner assigned yet. Set one from the org detail page.
            </p>
          )}
        </div>
        <div className="mt-6 flex gap-2">
          <Link
            href={`/platform/orgs/${result.organizationId}`}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
          >
            Open organization →
          </Link>
          <button
            onClick={() => {
              setResult(null);
              setName('');
              setOwnerEmail('');
              setError(null);
            }}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            Create another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl">
      <h2 className="mb-4 text-lg font-bold">New organization</h2>
      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-6"
      >
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-300">
            Organization name *
          </span>
          <input
            required
            minLength={2}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
            placeholder="Acme Clinic"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-300">
            Vertical (optional)
          </span>
          <select
            value={vertical}
            onChange={(e) => setVertical(e.target.value as never)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          >
            <option value="">(unset)</option>
            <option value="clinic">Clinic</option>
            <option value="salon">Salon</option>
            <option value="fitness">Fitness</option>
            <option value="mixed">Mixed</option>
          </select>
        </label>

        <fieldset className="rounded-md border border-slate-800 p-3">
          <legend className="px-1 text-[11px] font-semibold text-slate-400 uppercase">
            First location
          </legend>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-300">Location name</span>
            <input
              value={locationName}
              onChange={(e) => setLocationName(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            />
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-semibold text-slate-300">Type</span>
            <select
              value={locationType}
              onChange={(e) => setLocationType(e.target.value as 'clinic' | 'salon')}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              <option value="clinic">Clinic</option>
              <option value="salon">Salon</option>
            </select>
          </label>
        </fieldset>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-300">
            Owner email (optional)
          </span>
          <input
            type="email"
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            placeholder="owner@acmeclinic.com"
          />
          <span className="mt-1 block text-[11px] text-slate-400">
            If the email is already registered, they'll be promoted to ORG_OWNER of this new org.
            Otherwise an invitation link is generated (§9 rule 4 — never a temp password).
          </span>
        </label>

        {error && (
          <div className="rounded-md border border-red-800 bg-red-950 p-2 text-xs text-red-200">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2 pt-2">
          <button
            type="submit"
            disabled={busy || name.trim().length < 2}
            className="rounded-md bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create organization'}
          </button>
          <button
            type="button"
            onClick={() => router.push('/platform/orgs')}
            className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
