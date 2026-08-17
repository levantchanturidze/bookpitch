'use client';

import { useState, useTransition } from 'react';
import type { LocationType } from '@prisma/client';
import { Plus, Trash2 } from 'lucide-react';
import { createLocationAction, deleteLocationAction, updateLocationAction } from './actions';

export type LocationRow = {
  id: string;
  type: LocationType;
  name: string;
  timezone: string;
  taxRate: number;
  publicSlug: string | null;
  counts: { staff: number; appointments: number; services: number };
};

export default function LocationsPanel({ locations }: { locations: LocationRow[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<LocationRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = (
    id: string | null,
    input: Omit<LocationRow, 'id' | 'counts' | 'publicSlug'> & { publicSlug: string | null },
  ) => {
    setError(null);
    startTransition(async () => {
      try {
        if (id) await updateLocationAction(id, input);
        else await createLocationAction(input);
        setAdding(false);
        setEditing(null);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const remove = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await deleteLocationAction(id);
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">Locations — {locations.length}</h3>
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" /> Add location
        </button>
      </div>
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-100 bg-slate-50 font-mono text-[10px] tracking-wider text-slate-500 uppercase">
            <tr>
              <th scope="col" className="px-6 py-2 font-medium">
                Name
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Type
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Timezone
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Staff · Appts · Services
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Booking URL
              </th>
              <th scope="col" className="px-6 py-2 text-right font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {locations.map((l) => (
              <tr key={l.id}>
                <td className="px-6 py-2 font-bold text-slate-800">{l.name}</td>
                <td className="px-2 py-2 font-mono text-[11px] text-slate-500">{l.type}</td>
                <td className="px-2 py-2 font-mono text-[11px] text-slate-500">{l.timezone}</td>
                <td className="px-2 py-2 font-mono text-[11px] text-slate-500">
                  {l.counts.staff} · {l.counts.appointments} · {l.counts.services}
                </td>
                <td className="px-2 py-2 font-mono text-[11px]">
                  {l.publicSlug ? (
                    <a
                      href={`/book/${l.publicSlug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-600 hover:underline"
                    >
                      /book/{l.publicSlug}
                    </a>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="px-6 py-2 text-right">
                  <button
                    onClick={() => setEditing(l)}
                    className="mr-2 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete ${l.name}? Fails if it has staff or appointments.`)) {
                        remove(l.id);
                      }
                    }}
                    disabled={isPending}
                    className="rounded-md border border-rose-200 p-1.5 text-rose-500 hover:bg-rose-50 disabled:opacity-40"
                    title="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(adding || editing) && (
        <LocationForm
          initial={editing ?? undefined}
          isPending={isPending}
          onCancel={() => {
            setAdding(false);
            setEditing(null);
            setError(null);
          }}
          onSubmit={(values) =>
            save(editing?.id ?? null, { ...values, publicSlug: values.publicSlug })
          }
        />
      )}
    </section>
  );
}

function LocationForm({
  initial,
  isPending,
  onCancel,
  onSubmit,
}: {
  initial?: LocationRow;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (v: {
    type: LocationType;
    name: string;
    timezone: string;
    taxRate: number;
    publicSlug: string | null;
  }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<LocationType>(initial?.type ?? 'clinic');
  const [timezone, setTimezone] = useState(initial?.timezone ?? 'Asia/Tbilisi');
  const [taxRate, setTaxRate] = useState(String(initial?.taxRate ?? 0));
  const [publicSlug, setPublicSlug] = useState(initial?.publicSlug ?? '');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          name,
          type,
          timezone,
          taxRate: Number(taxRate),
          publicSlug: publicSlug.trim() || null,
        });
      }}
      className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-5"
    >
      <label className="text-[10px] font-bold tracking-wider text-slate-500 uppercase md:col-span-2">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-normal text-slate-800"
        />
      </label>
      <label className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
        Type
        <select
          value={type}
          onChange={(e) => setType(e.target.value as LocationType)}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-normal text-slate-800"
        >
          <option value="clinic">clinic</option>
          <option value="salon">salon</option>
        </select>
      </label>
      <label className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
        Timezone
        <input
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs font-normal text-slate-800"
        />
      </label>
      <label className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
        Tax rate
        <input
          value={taxRate}
          onChange={(e) => setTaxRate(e.target.value)}
          type="number"
          step="0.0001"
          min="0"
          max="1"
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs font-normal text-slate-800"
        />
      </label>
      <label className="text-[10px] font-bold tracking-wider text-slate-500 uppercase md:col-span-2">
        Public booking slug
        <input
          value={publicSlug}
          onChange={(e) => setPublicSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
          placeholder="e.g. tbilisi-clinic"
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs font-normal text-slate-800"
        />
        <span className="mt-0.5 block font-normal text-slate-400 normal-case">
          Leave blank to hide from public booking page.
        </span>
      </label>
      <div className="flex items-end justify-end gap-2 md:col-span-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-40"
        >
          {isPending ? 'Saving…' : initial ? 'Save changes' : 'Create location'}
        </button>
      </div>
    </form>
  );
}
