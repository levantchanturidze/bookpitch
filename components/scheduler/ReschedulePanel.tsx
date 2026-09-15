'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { AppointmentDto } from '@/lib/appointments';
import { localToUtc } from '@/lib/tz';
import StatusMessage from '@/components/ui/StatusMessage';
import { updateAppointmentAction } from './actions';
import { fetchRescheduleSlotsAction } from './reschedule-actions';

type StaffOption = {
  id: string;
  name: string;
  roleTitle: string;
};

type Props = {
  appointments: AppointmentDto[];
  staff: StaffOption[];
  timezone: string;
};

export default function ReschedulePanel({
  appointments,
  staff,
  timezone,
}: Props) {
  const router = useRouter();
  const candidates = useMemo(
    () =>
      appointments.filter(
        (a) => a.status === 'pending' || a.status === 'confirmed',
      ),
    [appointments],
  );

  const [appointmentId, setAppointmentId] = useState(candidates[0]?.id ?? '');
  const selected =
    candidates.find((a) => a.id === appointmentId) ?? candidates[0] ?? null;
  const [staffId, setStaffId] = useState(selected?.staffId ?? '');
  const [date, setDate] = useState(selected?.date ?? '');
  const [time, setTime] = useState(selected?.time ?? '');
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const chooseAppointment = (id: string) => {
    const next = candidates.find((a) => a.id === id);
    setAppointmentId(id);
    setError(null);
    setSuccess(null);
    setSlots(null);
    if (next) {
      setStaffId(next.staffId);
      setDate(next.date);
      setTime(next.time);
    }
  };

  useEffect(() => {
    if (!selected || !staffId || !date) return;

    let cancelled = false;
    setSlotsLoading(true);
    setSlots(null);
    fetchRescheduleSlotsAction(selected.id, staffId, date)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setSlots([]);
          setError(
            result.error === 'staff_not_at_location'
              ? 'That staff member does not work at this location.'
              : result.error === 'appointment_not_found'
                ? 'The appointment no longer exists.'
                : 'Could not load available times.',
          );
          return;
        }
        setSlots(result.slots);
        setTime((current) =>
          result.slots.includes(current) ? current : (result.slots[0] ?? ''),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setSlots([]);
          setError('Could not load available times.');
        }
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selected, staffId, date, refreshToken]);

  const submit = () => {
    if (!selected || !staffId || !date || !time) return;
    setError(null);
    setSuccess(null);

    startTransition(async () => {
      const result = await updateAppointmentAction(selected.id, {
        staffId,
        startsAt: localToUtc(date, time, timezone).toISOString(),
      });

      if (!result.ok) {
        if (result.error === 'slot_taken') {
          setError(
            'That slot was taken while you were rescheduling. Available times were refreshed.',
          );
          setRefreshToken((v) => v + 1);
        } else if (result.error === 'slot_outside_availability') {
          setError("That time is outside the staff member's availability.");
          setRefreshToken((v) => v + 1);
        } else {
          setError(result.error);
        }
        return;
      }

      if (!result.appointment) {
        setError('The appointment no longer exists.');
        return;
      }

      const moved = result.appointment;
      setStaffId(moved.staffId);
      setDate(moved.date);
      setTime(moved.time);
      setSuccess('Appointment rescheduled successfully.');
      setRefreshToken((v) => v + 1);

      const targetMonth = moved.date.slice(0, 7);
      if (targetMonth !== selected.date.slice(0, 7)) {
        router.push(`/scheduler?month=${targetMonth}`);
      } else {
        router.refresh();
      }
    });
  };

  return (
    <section
      aria-labelledby="reschedule-appointment-heading"
      className="rounded-xl border border-slate-200 bg-white p-6"
    >
      <div className="mb-4">
        <h2
          id="reschedule-appointment-heading"
          className="text-base font-bold text-slate-800"
        >
          Reschedule Appointment
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Move an existing pending or confirmed booking without letting it block
          its own slot.
        </p>
      </div>

      {candidates.length === 0 || !selected ? (
        <StatusMessage>
          No pending or confirmed appointments are available in this month.
        </StatusMessage>
      ) : (
        <div className="grid gap-4 lg:grid-cols-4">
          <label className="block lg:col-span-2">
            <span className="mb-1 block text-xs font-bold text-slate-500">
              Appointment
            </span>
            <select
              aria-label="Appointment"
              value={selected.id}
              onChange={(e) => chooseAppointment(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700"
            >
              {candidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.date} · {a.time} · {a.customer.name} · {a.serviceName}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-bold text-slate-500">
              Staff
            </span>
            <select
              aria-label="Staff"
              value={staffId}
              onChange={(e) => {
                setStaffId(e.target.value);
                setTime('');
                setError(null);
                setSuccess(null);
              }}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700"
            >
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.roleTitle}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-bold text-slate-500">
              Date
            </span>
            <input
              aria-label="Date"
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setTime('');
                setError(null);
                setSuccess(null);
              }}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
            />
          </label>

          <div className="lg:col-span-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-slate-500">
                Available time
              </span>
              <span className="text-[10px] text-slate-500">
                Current:{' '}
                <strong
                  data-testid="reschedule-current-time"
                  className="font-mono"
                >
                  {selected.time}
                </strong>
              </span>
            </div>
            {slotsLoading ? (
              <div className="flex h-[38px] items-center rounded-lg border border-slate-200 bg-slate-50 px-2 font-mono text-xs text-slate-500">
                Loading…
              </div>
            ) : slots === null ? (
              <div className="flex h-[38px] items-center rounded-lg border border-slate-100 bg-slate-50 px-2 text-xs text-slate-500">
                Choose an appointment, staff member and date.
              </div>
            ) : slots.length === 0 ? (
              <div className="flex h-[38px] items-center rounded-lg border border-rose-100 bg-rose-50 px-2 text-xs text-rose-600">
                No available times
              </div>
            ) : (
              <select
                aria-label="Available time"
                value={time}
                onChange={(e) => {
                  setTime(e.target.value);
                  setError(null);
                  setSuccess(null);
                }}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs text-slate-700"
              >
                {slots.map((slot) => (
                  <option key={slot} value={slot}>
                    {slot}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex items-end lg:col-span-2">
            <button
              type="button"
              onClick={submit}
              disabled={isPending || slotsLoading || !time}
              className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? 'Saving…' : 'Save new time'}
            </button>
          </div>

          <div className="lg:col-span-4">
            <StatusMessage
              tone={error ? 'error' : success ? 'success' : 'info'}
            >
              {error ?? success}
            </StatusMessage>
          </div>
        </div>
      )}
    </section>
  );
}
