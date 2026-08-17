'use client';

import { useId, useState, useTransition } from 'react';
import { CalendarClock, Plus, Trash2 } from 'lucide-react';
import type { AvailabilityWindow } from '@/lib/admin';
import ModalShell from '@/components/ui/ModalShell';
import {
  createStaffAction,
  deleteStaffAction,
  setAvailabilityAction,
  updateStaffAction,
} from './actions';

export type LocationRef = { id: string; name: string; type: 'clinic' | 'salon'; timezone: string };

export type StaffRow = {
  id: string;
  locationId: string;
  locationName: string;
  name: string;
  roleTitle: string;
  specialty: string | null;
  email: string | null;
  phone: string | null;
  calendarColor: string | null;
  availability: Array<{ weekday: number; startTime: string; endTime: string }>;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function StaffPanel({
  staff,
  locations,
}: {
  staff: StaffRow[];
  locations: LocationRef[];
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [availOpen, setAvailOpen] = useState<StaffRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = (
    id: string | null,
    input: Omit<StaffRow, 'id' | 'availability' | 'locationName'>,
  ) => {
    setError(null);
    startTransition(async () => {
      try {
        if (id) await updateStaffAction(id, input);
        else await createStaffAction(input);
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
      const result = await deleteStaffAction(id);
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">Staff — {staff.length}</h3>
        <button
          onClick={() => setAdding(true)}
          disabled={locations.length === 0}
          className="flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-40"
          title={locations.length === 0 ? 'Add a location first' : undefined}
        >
          <Plus className="h-3.5 w-3.5" /> Add staff
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
                Role
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Location
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Contact
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Availability
              </th>
              <th scope="col" className="px-6 py-2 text-right font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {staff.map((s) => (
              <tr key={s.id}>
                <td className="px-6 py-2">
                  <span className="font-bold text-slate-800">{s.name}</span>
                  {s.calendarColor && (
                    <span
                      className="ml-2 inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: s.calendarColor }}
                    />
                  )}
                </td>
                <td className="px-2 py-2 text-slate-600">
                  {s.roleTitle}
                  {s.specialty && (
                    <span className="block text-[10px] text-slate-400">{s.specialty}</span>
                  )}
                </td>
                <td className="px-2 py-2 text-slate-600">{s.locationName}</td>
                <td className="px-2 py-2 font-mono text-[11px] text-slate-500">
                  {s.email ?? '—'} · {s.phone ?? '—'}
                </td>
                <td className="px-2 py-2 font-mono text-[10px] text-slate-500">
                  {s.availability.length} window{s.availability.length === 1 ? '' : 's'}
                </td>
                <td className="px-6 py-2 text-right">
                  <button
                    onClick={() => setAvailOpen(s)}
                    className="mr-2 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                    title="Edit availability"
                  >
                    <CalendarClock className="inline h-3 w-3" />
                  </button>
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
        <StaffForm
          initial={editing ?? undefined}
          locations={locations}
          isPending={isPending}
          onCancel={() => {
            setAdding(false);
            setEditing(null);
            setError(null);
          }}
          onSubmit={(values) => save(editing?.id ?? null, values)}
        />
      )}

      {availOpen && <AvailabilityEditor staff={availOpen} onClose={() => setAvailOpen(null)} />}
    </section>
  );
}

function StaffForm({
  initial,
  locations,
  isPending,
  onCancel,
  onSubmit,
}: {
  initial?: StaffRow;
  locations: LocationRef[];
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (v: {
    locationId: string;
    name: string;
    roleTitle: string;
    specialty: string | null;
    email: string | null;
    phone: string | null;
    calendarColor: string | null;
  }) => void;
}) {
  const [locationId, setLocationId] = useState(initial?.locationId ?? locations[0]?.id ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [roleTitle, setRoleTitle] = useState(initial?.roleTitle ?? '');
  const [specialty, setSpecialty] = useState(initial?.specialty ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [calendarColor, setCalendarColor] = useState(initial?.calendarColor ?? '#0d9488');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          locationId,
          name,
          roleTitle,
          specialty: specialty || null,
          email: email || null,
          phone: phone || null,
          calendarColor: calendarColor || null,
        });
      }}
      className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-3"
    >
      <Field label="Location">
        <select
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          required
          className="w-full rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-800"
        >
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Full name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="w-full rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-800"
        />
      </Field>
      <Field label="Role title">
        <input
          value={roleTitle}
          onChange={(e) => setRoleTitle(e.target.value)}
          required
          className="w-full rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-800"
        />
      </Field>
      <Field label="Specialty">
        <input
          value={specialty}
          onChange={(e) => setSpecialty(e.target.value)}
          className="w-full rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-800"
        />
      </Field>
      <Field label="Email">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          className="w-full rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-800"
        />
      </Field>
      <Field label="Phone">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="w-full rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-800"
        />
      </Field>
      <Field label="Calendar color">
        <input
          value={calendarColor}
          onChange={(e) => setCalendarColor(e.target.value)}
          type="color"
          className="h-9 w-full rounded-lg border border-slate-200 bg-white p-1"
        />
      </Field>
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
          {isPending ? 'Saving…' : initial ? 'Save changes' : 'Create staff'}
        </button>
      </div>
    </form>
  );
}

function AvailabilityEditor({ staff, onClose }: { staff: StaffRow; onClose: () => void }) {
  const titleId = useId();
  const initial: Array<{ start: string; end: string }> = WEEKDAYS.map((_, weekday) => {
    const w = staff.availability.find((a) => a.weekday === weekday);
    return { start: w?.startTime ?? '', end: w?.endTime ?? '' };
  });
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = () => {
    setError(null);
    const windows: AvailabilityWindow[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const r = rows[weekday];
      if (!r.start && !r.end) continue;
      if (!r.start || !r.end) {
        setError(`${WEEKDAYS[weekday]}: both start and end required (leave blank for day off)`);
        return;
      }
      windows.push({ weekday, startTime: r.start, endTime: r.end });
    }
    startTransition(async () => {
      try {
        await setAvailabilityAction(staff.id, windows);
        onClose();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  return (
    <ModalShell titleId={titleId} onDismiss={onClose} panelClassName="w-full max-w-md">
      <h2 id={titleId} className="mb-1 text-base font-bold text-slate-800">
        Availability · {staff.name}
      </h2>
      <p className="mb-4 text-xs text-slate-500">
        Times are in the location&apos;s local timezone. Leave both fields blank for a day off.
        Split shifts aren&apos;t supported in this MVP editor — one window per day.
      </p>
      <div className="space-y-2">
        {WEEKDAYS.map((day, i) => (
          <div key={day} className="flex items-center gap-2">
            <span className="w-10 font-mono text-[11px] tracking-wider text-slate-500 uppercase">
              {day}
            </span>
            <input
              type="time"
              value={rows[i].start}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...next[i], start: e.target.value };
                setRows(next);
              }}
              className="w-28 rounded-lg border border-slate-200 bg-slate-50 p-1.5 text-xs text-slate-700"
            />
            <span className="text-slate-400">–</span>
            <input
              type="time"
              value={rows[i].end}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...next[i], end: e.target.value };
                setRows(next);
              }}
              className="w-28 rounded-lg border border-slate-200 bg-slate-50 p-1.5 text-xs text-slate-700"
            />
            <button
              onClick={() => {
                const next = [...rows];
                next[i] = { start: '', end: '' };
                setRows(next);
              }}
              className="ml-auto text-[10px] text-slate-400 hover:text-slate-600"
            >
              Off
            </button>
          </div>
        ))}
      </div>
      {error && (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      )}
      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={isPending}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-40"
        >
          {isPending ? 'Saving…' : 'Save availability'}
        </button>
      </div>
    </ModalShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[10px] font-bold tracking-wider text-slate-500 uppercase">
      {label}
      <div className="mt-1 font-normal normal-case">{children}</div>
    </label>
  );
}
