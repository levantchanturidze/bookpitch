'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { createServiceAction, deleteServiceAction, updateServiceAction } from './actions';
import type { LocationRef } from './StaffPanel';

export type ServiceRow = {
  id: string;
  locationId: string;
  locationName: string;
  name: string;
  category: string | null;
  price: number;
  durationMinutes: number;
  isActive: boolean;
};

export default function ServicesPanel({
  services,
  locations,
  currency,
}: {
  services: ServiceRow[];
  locations: LocationRef[];
  currency: string;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ServiceRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = (id: string | null, input: Omit<ServiceRow, 'id' | 'locationName'>) => {
    setError(null);
    startTransition(async () => {
      try {
        if (id) await updateServiceAction(id, input);
        else await createServiceAction(input);
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
      const result = await deleteServiceAction(id);
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">Services — {services.length}</h3>
        <button
          onClick={() => setAdding(true)}
          disabled={locations.length === 0}
          className="flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" /> Add service
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
                Location
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Category
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Price · Duration
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Active
              </th>
              <th scope="col" className="px-6 py-2 text-right font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {services.map((s) => (
              <tr key={s.id}>
                <td className="px-6 py-2 font-bold text-slate-800">{s.name}</td>
                <td className="px-2 py-2 text-slate-600">{s.locationName}</td>
                <td className="px-2 py-2 text-slate-500">{s.category ?? '—'}</td>
                <td className="px-2 py-2 font-mono text-[11px] text-slate-600">
                  {s.price.toFixed(2)} {currency} · {s.durationMinutes}m
                </td>
                <td className="px-2 py-2">
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      s.isActive
                        ? 'border border-emerald-100 bg-emerald-50 text-emerald-700'
                        : 'border border-slate-200 bg-slate-50 text-slate-500'
                    }`}
                  >
                    {s.isActive ? 'active' : 'inactive'}
                  </span>
                </td>
                <td className="px-6 py-2 text-right">
                  <button
                    onClick={() => setEditing(s)}
                    className="mr-2 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete ${s.name}?`)) remove(s.id);
                    }}
                    disabled={isPending}
                    className="rounded-md border border-rose-200 p-1.5 text-rose-500 hover:bg-rose-50 disabled:opacity-40"
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
        <ServiceForm
          initial={editing ?? undefined}
          locations={locations}
          currency={currency}
          isPending={isPending}
          onCancel={() => {
            setAdding(false);
            setEditing(null);
            setError(null);
          }}
          onSubmit={(values) => save(editing?.id ?? null, values)}
        />
      )}
    </section>
  );
}

function ServiceForm({
  initial,
  locations,
  currency,
  isPending,
  onCancel,
  onSubmit,
}: {
  initial?: ServiceRow;
  locations: LocationRef[];
  currency: string;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (v: {
    locationId: string;
    name: string;
    category: string | null;
    price: number;
    durationMinutes: number;
    isActive: boolean;
  }) => void;
}) {
  const [locationId, setLocationId] = useState(initial?.locationId ?? locations[0]?.id ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [price, setPrice] = useState(String(initial?.price ?? 100));
  const [duration, setDuration] = useState(String(initial?.durationMinutes ?? 30));
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          locationId,
          name,
          category: category || null,
          price: Number(price),
          durationMinutes: Number(duration),
          isActive,
        });
      }}
      className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-6"
    >
      <label className="text-[10px] font-bold tracking-wider text-slate-500 uppercase md:col-span-2">
        Location
        <select
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          required
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-normal text-slate-800"
        >
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[10px] font-bold tracking-wider text-slate-500 uppercase md:col-span-2">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-normal text-slate-800"
        />
      </label>
      <label className="text-[10px] font-bold tracking-wider text-slate-500 uppercase md:col-span-2">
        Category
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs font-normal text-slate-800"
        />
      </label>
      <label className="text-[10px] font-bold tracking-wider text-slate-500 uppercase md:col-span-2">
        Price ({currency})
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          type="number"
          step="0.01"
          min="0"
          required
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs font-normal text-slate-800"
        />
      </label>
      <label className="text-[10px] font-bold tracking-wider text-slate-500 uppercase md:col-span-2">
        Duration (min)
        <input
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          type="number"
          min="1"
          required
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs font-normal text-slate-800"
        />
      </label>
      <label className="flex items-end gap-2 text-xs text-slate-700 md:col-span-2">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="h-4 w-4"
        />
        Active
      </label>
      <div className="flex items-end justify-end gap-2 md:col-span-6">
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
          {isPending ? 'Saving…' : initial ? 'Save changes' : 'Create service'}
        </button>
      </div>
    </form>
  );
}
