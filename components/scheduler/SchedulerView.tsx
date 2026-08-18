'use client';

import { useEffect, useMemo, useState, useTransition, useId } from 'react';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  DollarSign,
  Filter,
  Plus,
  Sparkles,
  Stethoscope,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

import type { AppointmentDto } from '@/lib/appointments';
import type { AppointmentStatus, PaymentStatus } from '@prisma/client';
import {
  bookAppointmentAction,
  fetchAvailableSlotsAction,
  updateAppointmentAction,
} from './actions';
import { localToUtc, toLocalDate } from '@/lib/tz';
import AssistantModal from './AssistantModal';
import ModalShell from '@/components/ui/ModalShell';
import StatusMessage from '@/components/ui/StatusMessage';

// -----------------------------------------------------------------------------
// Types passed by the server component.
// -----------------------------------------------------------------------------
export type ScheduleLocation = {
  id: string;
  type: 'clinic' | 'salon';
  name: string;
  timezone: string;
};
export type ScheduleStaff = {
  id: string;
  name: string;
  roleTitle: string;
  specialty: string | null;
  calendarColor: string | null;
};
export type ScheduleService = {
  id: string;
  name: string;
  price: number;
  durationMinutes: number;
};
export type ScheduleCustomer = { id: string; name: string; phone: string | null };

type Props = {
  location: ScheduleLocation;
  staff: ScheduleStaff[];
  services: ScheduleService[];
  customers: ScheduleCustomer[];
  appointments: AppointmentDto[];
  monthAnchorIso: string; // YYYY-MM-01 of the month currently on screen
};

const STATUS_BADGES: Record<AppointmentStatus, string> = {
  pending: 'bg-amber-100 text-amber-800 border-amber-200',
  confirmed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  completed: 'bg-blue-100 text-blue-800 border-blue-200',
  cancelled: 'bg-rose-100 text-rose-800 border-rose-200',
};

function localTodayStr(tz: string): string {
  return toLocalDate(new Date(), tz);
}

// -----------------------------------------------------------------------------
// Main view
// -----------------------------------------------------------------------------
export default function SchedulerView(props: Props) {
  const { location, staff, services, customers, appointments, monthAnchorIso } = props;
  const isClinic = location.type === 'clinic';
  const accent = isClinic ? 'teal' : 'pink';
  const tz = location.timezone;
  const today = localTodayStr(tz);

  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [anchor, setAnchor] = useState<Date>(new Date(monthAnchorIso));
  const [filterStaff, setFilterStaff] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [bookOpen, setBookOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantDraft, setAssistantDraft] = useState<BookingInput | null>(null);
  const [selected, setSelected] = useState<AppointmentDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    return appointments.filter((a) => {
      if (a.date !== selectedDate) return false;
      if (filterStaff !== 'all' && a.staffId !== filterStaff) return false;
      if (filterStatus !== 'all' && a.status !== filterStatus) return false;
      return true;
    });
  }, [appointments, selectedDate, filterStaff, filterStatus]);

  const days = useMemo(() => buildMonthGrid(anchor), [anchor]);

  const bookingCountsByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of appointments) {
      if (a.status === 'cancelled') continue;
      map.set(a.date, (map.get(a.date) ?? 0) + 1);
    }
    return map;
  }, [appointments]);

  const handleBook = (input: BookingInput) => {
    setError(null);
    startTransition(async () => {
      const result = await bookAppointmentAction({
        locationId: location.id,
        customerId: input.customerId,
        staffId: input.staffId,
        serviceId: input.serviceId,
        startsAt: localToUtc(input.date, input.time, tz).toISOString(),
        notes: input.notes || null,
      });
      if (!result.ok) {
        setError(
          result.error === 'slot_taken'
            ? 'That time slot was just taken. The available times have been refreshed — please choose another.'
            : result.error === 'slot_outside_availability'
              ? "That time is outside the staff member's availability."
              : result.error,
        );
      } else {
        setBookOpen(false);
        setAssistantDraft(null);
      }
    });
  };

  const handleUpdate = (
    id: string,
    patch: { status?: AppointmentStatus; paymentStatus?: PaymentStatus },
  ) => {
    setError(null);
    startTransition(async () => {
      const result = await updateAppointmentAction(id, patch);
      if (!result.ok) {
        setError(
          result.error === 'slot_taken' ? 'That time slot is no longer available.' : result.error,
        );
      } else {
        setSelected(null);
      }
    });
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* ------------------- Left pane: month calendar ---------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-7">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`rounded-lg p-2 ${isClinic ? 'bg-teal-50 text-teal-600' : 'bg-pink-50 text-pink-600'}`}
            >
              {isClinic ? <Stethoscope className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
            </div>
            <div>
              <h2 className="font-sans text-xl font-bold text-slate-800">
                {isClinic ? 'Medical Appointments' : 'Salon Appointments'}
              </h2>
              <p className="text-xs text-slate-500">
                Manage {isClinic ? 'patient visits' : 'styling sessions'} at {location.name}
              </p>
            </div>
          </div>

          <MonthNav anchor={anchor} onChange={setAnchor} />
        </div>

        <MonthGrid
          days={days}
          selectedDate={selectedDate}
          today={today}
          isClinic={isClinic}
          bookingCounts={bookingCountsByDay}
          onSelect={setSelectedDate}
        />

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4 text-xs text-slate-500">
          <div className="flex items-center gap-3">
            <Legend color="bg-emerald-500" label="Confirmed" />
            <Legend color="bg-amber-500" label="Pending" />
            <Legend color="bg-blue-500" label="Completed" />
            <Legend color="bg-rose-500" label="Cancelled" />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAssistantOpen(true)}
              className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              <Sparkles className="h-4 w-4" />
              Assistant
            </button>
            <button
              onClick={() => setBookOpen(true)}
              className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-medium text-white shadow-sm transition ${
                accent === 'teal'
                  ? 'bg-teal-700 hover:bg-teal-800 hover:shadow-teal-100'
                  : 'bg-pink-600 hover:bg-pink-700 hover:shadow-pink-100'
              }`}
            >
              <Plus className="h-4 w-4" />
              Book Appointment
            </button>
          </div>
        </div>
      </section>

      {/* ------------------- Right pane: filters + day list ---------------- */}
      <section className="flex flex-col gap-6 lg:col-span-5">
        <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-xs font-bold tracking-wider text-slate-500">
              <Filter className="h-3 w-3" /> LIST FILTERS
            </span>
            <button
              onClick={() => {
                setFilterStaff('all');
                setFilterStatus('all');
              }}
              className="text-[10px] text-slate-500 underline hover:text-slate-600"
            >
              Reset
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <FilterSelect
              label="Staff"
              value={filterStaff}
              onChange={setFilterStaff}
              options={[
                { value: 'all', label: 'All Staff' },
                ...staff.map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
            <FilterSelect
              label="Status"
              value={filterStatus}
              onChange={setFilterStatus}
              options={[
                { value: 'all', label: 'All Statuses' },
                { value: 'pending', label: 'Pending' },
                { value: 'confirmed', label: 'Confirmed' },
                { value: 'completed', label: 'Completed' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
            />
          </div>
        </div>

        <div className="flex flex-1 flex-col rounded-xl border border-slate-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between border-b border-slate-50 pb-3">
            <div>
              <h3 className="text-sm font-bold text-slate-800">
                Bookings for {formatFriendly(selectedDate)}
              </h3>
              <p className="text-[10px] text-slate-500">Total: {filtered.length} bookings</p>
            </div>
            <span className="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-600">
              {selectedDate}
            </span>
          </div>

          {error && (
            <StatusMessage tone="error" className="mb-3">
              {error}
            </StatusMessage>
          )}

          <div className="max-h-[380px] flex-1 space-y-3 overflow-y-auto pr-1">
            {filtered.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center py-12 text-center text-slate-500">
                <CalendarIcon className="mb-2 h-8 w-8 stroke-1 text-slate-300" aria-hidden="true" />
                <p className="text-xs font-medium">No appointments for this date</p>
              </div>
            ) : (
              filtered.map((a) => (
                <AppointmentRow key={a.id} a={a} onSelect={() => setSelected(a)} />
              ))
            )}
          </div>
        </div>
      </section>

      {/* ----------- Book modal (create) -------------------------------------- */}
      <AnimatePresence>
        {bookOpen && (
          <BookingModal
            date={selectedDate}
            services={services}
            staff={staff}
            customers={customers}
            isClinic={isClinic}
            accent={accent}
            isPending={isPending}
            error={error}
            prefill={assistantDraft}
            onCancel={() => {
              setBookOpen(false);
              setAssistantDraft(null);
              setError(null);
            }}
            onSubmit={(v) => {
              handleBook(v);
            }}
          />
        )}
      </AnimatePresence>

      {/* ----------- Assistant modal (natural-language booking) --------------- */}
      <AnimatePresence>
        {assistantOpen && (
          <AssistantModal
            locationId={location.id}
            accent={accent}
            onCancel={() => setAssistantOpen(false)}
            onConfirm={(d) => {
              setAssistantOpen(false);
              startTransition(async () => {
                const result = await bookAppointmentAction({
                  locationId: location.id,
                  customerId: d.customerId,
                  staffId: d.staffId,
                  serviceId: d.serviceId,
                  startsAt: d.startsAt,
                  notes: d.notes,
                });
                if (!result.ok) {
                  setError(
                    result.error === 'slot_taken'
                      ? 'That time slot was just taken. Please book another.'
                      : result.error,
                  );
                }
              });
            }}
            onEdit={(prefill) => {
              setAssistantOpen(false);
              setAssistantDraft({
                customerId: prefill.customerId ?? '',
                staffId: prefill.staffId ?? '',
                serviceId: prefill.serviceId ?? '',
                date: prefill.date,
                time: prefill.time,
                notes: prefill.notes,
              });
              setSelectedDate(prefill.date);
              setBookOpen(true);
            }}
          />
        )}
      </AnimatePresence>

      {/* ----------- Detail modal (status + payment) ------------------------- */}
      <AnimatePresence>
        {selected && (
          <DetailModal
            appointment={selected}
            isPending={isPending}
            onClose={() => setSelected(null)}
            onUpdate={(patch) => handleUpdate(selected.id, patch)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Month navigator + calendar grid
// -----------------------------------------------------------------------------
function MonthNav({ anchor, onChange }: { anchor: Date; onChange: (d: Date) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-slate-100 bg-slate-50 p-1">
      <button
        onClick={() =>
          onChange(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1)))
        }
        className="rounded-md p-1.5 text-slate-600 transition hover:bg-white"
        title="Previous month"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="min-w-[100px] px-3 py-1 text-center text-xs font-semibold text-slate-700">
        {new Intl.DateTimeFormat('en-US', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(anchor)}
      </span>
      <button
        onClick={() =>
          onChange(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1)))
        }
        className="rounded-md p-1.5 text-slate-600 transition hover:bg-white"
        title="Next month"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

function MonthGrid({
  days,
  selectedDate,
  today,
  isClinic,
  bookingCounts,
  onSelect,
}: {
  days: (string | null)[];
  selectedDate: string;
  today: string;
  isClinic: boolean;
  bookingCounts: Map<string, number>;
  onSelect: (d: string) => void;
}) {
  return (
    <>
      <div className="mb-2 grid grid-cols-7 gap-1 text-center font-mono text-[10px] font-bold tracking-wider text-slate-500">
        {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-2">
        {days.map((dateStr, idx) => {
          if (!dateStr) {
            return <div key={`empty-${idx}`} className="aspect-square rounded-lg bg-slate-50/50" />;
          }
          const isSelected = dateStr === selectedDate;
          const isToday = dateStr === today;
          const count = bookingCounts.get(dateStr) ?? 0;
          const day = Number(dateStr.slice(8, 10));

          return (
            <button
              key={dateStr}
              onClick={() => onSelect(dateStr)}
              className={`relative flex aspect-square flex-col justify-between rounded-xl border p-2 transition ${
                isSelected
                  ? isClinic
                    ? 'border-teal-700 bg-teal-700 text-white shadow-md shadow-teal-100'
                    : 'border-pink-600 bg-pink-600 text-white shadow-md shadow-pink-100'
                  : isToday
                    ? 'border-slate-300 bg-slate-50 font-bold text-slate-800'
                    : 'border-slate-100 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <span className="text-xs font-semibold">{day}</span>
              {count > 0 && (
                <div className="flex w-full justify-end">
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-mono text-[9px] leading-none font-bold ${
                      isSelected
                        ? 'bg-white text-slate-900'
                        : isClinic
                          ? 'bg-teal-50 text-teal-700'
                          : 'bg-pink-50 text-pink-700'
                    }`}
                  >
                    {count}
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

function buildMonthGrid(anchor: Date): (string | null)[] {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const firstDayOfWeek = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
  for (let d = 1; d <= lastDay; d++) {
    const iso = new Date(Date.UTC(year, month, d)).toISOString().slice(0, 10);
    cells.push(iso);
  }
  return cells;
}

// -----------------------------------------------------------------------------
// Day-list row + detail modal + booking modal
// -----------------------------------------------------------------------------
function AppointmentRow({ a, onSelect }: { a: AppointmentDto; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="relative flex w-full items-start gap-3 overflow-hidden rounded-xl border border-slate-100 p-3 text-left transition hover:border-slate-200 hover:bg-slate-50/50"
    >
      <div
        className="absolute top-0 bottom-0 left-0 w-1.5"
        style={{ backgroundColor: a.staff.calendarColor ?? '#cbd5e1' }}
      />
      <div className="min-w-0 flex-1 pl-2">
        <div className="mb-0.5 flex items-center justify-between">
          <span className="block truncate text-xs font-bold text-slate-800">{a.customer.name}</span>
          <span className="flex items-center gap-1 font-mono text-[10px] font-medium text-slate-500">
            <Clock className="h-2.5 w-2.5" /> {a.time} ({a.durationMinutes}m)
          </span>
        </div>
        <p className="truncate text-[10px] font-medium text-slate-500">{a.serviceName}</p>
        <div className="mt-2 flex items-center justify-between border-t border-slate-100/50 pt-2">
          <span className="font-mono text-[9px] text-slate-500">
            Staff: <strong className="font-sans text-slate-600">{a.staff.name}</strong>
          </span>
          <div className="flex items-center gap-1.5">
            <span
              className={`rounded-full border px-1.5 py-0.5 text-[9px] ${STATUS_BADGES[a.status]}`}
            >
              {a.status}
            </span>
            <span
              className={`rounded px-1 font-mono text-[9px] ${
                a.paymentStatus === 'paid'
                  ? 'bg-emerald-50 text-emerald-600'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {a.paymentStatus}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

function DetailModal({
  appointment: a,
  isPending,
  onClose,
  onUpdate,
}: {
  appointment: AppointmentDto;
  isPending: boolean;
  onClose: () => void;
  onUpdate: (patch: { status?: AppointmentStatus; paymentStatus?: PaymentStatus }) => void;
}) {
  const dlgTitleId = useId();
  return (
    <ModalShell titleId={dlgTitleId} panelClassName={null} onDismiss={onClose}>
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="relative w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <span className="font-mono text-[10px] font-bold tracking-wide text-slate-500 uppercase">
              Booking Details
            </span>
            <h2 id={dlgTitleId} className="text-base font-bold text-slate-800">
              {a.serviceName}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-sm font-semibold text-slate-500 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white font-mono text-xs font-bold text-slate-500">
              {a.customer.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <span className="block text-xs font-bold text-slate-800">{a.customer.name}</span>
              <span className="block font-mono text-[10px] text-slate-500">
                {a.customer.phone ?? '—'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <span className="mb-0.5 block font-semibold text-slate-500">DATE & TIME</span>
              <p className="font-mono font-medium text-slate-700">{a.date}</p>
              <p className="font-mono text-slate-500">
                at {a.time} ({a.durationMinutes} mins)
              </p>
            </div>
            <div>
              <span className="mb-0.5 block font-semibold text-slate-500">STAFF</span>
              <p className="font-medium text-slate-700">{a.staff.name}</p>
              <p className="text-[10px] text-slate-500">{a.staff.roleTitle}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-xs">
            <div>
              <span className="mb-0.5 block font-semibold text-slate-500">COST</span>
              <p className="text-sm font-bold text-slate-800">${a.price.toFixed(2)}</p>
            </div>
            <div>
              <span className="mb-0.5 block font-semibold text-slate-500">PAYMENT</span>
              <span
                className={`rounded px-2 py-0.5 font-mono text-[10px] ${
                  a.paymentStatus === 'paid'
                    ? 'border border-emerald-100 bg-emerald-50 text-emerald-600'
                    : 'border border-amber-100 bg-amber-50 text-amber-600'
                }`}
              >
                {a.paymentStatus}
              </span>
            </div>
          </div>

          {a.notes && (
            <div className="rounded-lg border border-blue-100/50 bg-blue-50/50 p-2.5 text-[11px] text-slate-600">
              <strong className="mb-0.5 block text-slate-700">Notes:</strong>
              {a.notes}
            </div>
          )}

          <div className="space-y-2 border-t border-slate-100 pt-3">
            <span className="block font-mono text-[10px] font-bold tracking-wide text-slate-500 uppercase">
              Update Status
            </span>
            <div className="flex flex-wrap gap-1.5">
              <StatusButton
                disabled={isPending}
                onClick={() => onUpdate({ status: 'confirmed' })}
                className="border-emerald-100 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
              >
                ✓ Confirm
              </StatusButton>
              <StatusButton
                disabled={isPending}
                onClick={() => onUpdate({ status: 'completed' })}
                className="border-blue-100 bg-blue-50 text-blue-700 hover:bg-blue-100"
              >
                ✓ Complete
              </StatusButton>
              <StatusButton
                disabled={isPending}
                onClick={() => onUpdate({ status: 'cancelled' })}
                className="border-rose-100 bg-rose-50 text-rose-700 hover:bg-rose-100"
              >
                ✕ Cancel
              </StatusButton>
            </div>

            {a.paymentStatus !== 'paid' && (
              <button
                disabled={isPending}
                onClick={() => onUpdate({ paymentStatus: 'paid' })}
                className="flex w-full items-center justify-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-800 disabled:opacity-50"
              >
                <DollarSign className="h-3.5 w-3.5" />
                Mark as Paid (Cash / Terminal)
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </ModalShell>
  );
}

type BookingInput = {
  customerId: string;
  staffId: string;
  serviceId: string;
  date: string;
  time: string;
  notes: string;
};

function BookingModal({
  date,
  services,
  staff,
  customers,
  isClinic,
  accent,
  isPending,
  error,
  prefill,
  onCancel,
  onSubmit,
}: {
  date: string;
  services: ScheduleService[];
  staff: ScheduleStaff[];
  customers: ScheduleCustomer[];
  isClinic: boolean;
  accent: 'teal' | 'pink';
  isPending: boolean;
  error: string | null;
  prefill?: BookingInput | null;
  onCancel: () => void;
  onSubmit: (v: BookingInput) => void;
}) {
  const dlgTitleId2 = useId();
  const [values, setValues] = useState<BookingInput>(
    prefill ?? {
      customerId: '',
      staffId: '',
      serviceId: '',
      date,
      time: '',
      notes: '',
    },
  );
  // null = not yet loaded, [] = loaded but empty, string[] = available slots
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const activeService = services.find((s) => s.id === values.serviceId);

  // Load available slots whenever provider + service + date are all chosen.
  useEffect(() => {
    if (!values.staffId || !values.serviceId || !values.date) {
      setSlots(null);
      return;
    }
    const svc = services.find((s) => s.id === values.serviceId);
    if (!svc) return;
    setSlotsLoading(true);
    setSlots(null);
    let cancelled = false;
    fetchAvailableSlotsAction(values.staffId, values.date, svc.durationMinutes)
      .then((s) => {
        if (cancelled) return;
        setSlots(s);
        // Keep the prefilled time if it's still available; otherwise pick the
        // first open slot so the form is always in a submittable state.
        if (s.length > 0) {
          setValues((v) => ({ ...v, time: s.includes(v.time) ? v.time : s[0] }));
        } else {
          setValues((v) => ({ ...v, time: '' }));
        }
      })
      .catch(() => {
        if (!cancelled) setSlots([]);
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [values.staffId, values.serviceId, values.date, services]);

  const canSubmit =
    !!values.customerId && !!values.staffId && !!values.serviceId && !!values.date && !!values.time;

  return (
    <ModalShell titleId={dlgTitleId2} panelClassName={null} onDismiss={onCancel}>
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2
            id={dlgTitleId2}
            className="flex items-center gap-1.5 text-base font-bold text-slate-800"
          >
            <Plus className="h-4 w-4" /> Book Appointment
          </h2>
          <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600">
            {date}
          </span>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(values);
          }}
          className="space-y-3"
        >
          <Field label={`Select ${isClinic ? 'Patient' : 'Client'} *`}>
            <select
              required
              value={values.customerId}
              onChange={(e) => setValues({ ...values, customerId: e.target.value })}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700"
            >
              <option value="">-- Choose --</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.phone ? `(${c.phone})` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Assign ${isClinic ? 'Practitioner' : 'Stylist'} *`}>
            <select
              required
              value={values.staffId}
              onChange={(e) => setValues({ ...values, staffId: e.target.value })}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700"
            >
              <option value="">-- Choose --</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.roleTitle}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Select Service *">
            <select
              required
              value={values.serviceId}
              onChange={(e) => setValues({ ...values, serviceId: e.target.value })}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700"
            >
              <option value="">-- Choose --</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} (${s.price} · {s.durationMinutes} min)
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <input
                type="date"
                required
                value={values.date}
                onChange={(e) => setValues({ ...values, date: e.target.value, time: '' })}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
              />
            </Field>
            <Field label="Available Time">
              {slotsLoading ? (
                <div className="flex h-[34px] items-center rounded-lg border border-slate-200 bg-slate-50 px-2 font-mono text-xs text-slate-500">
                  Loading…
                </div>
              ) : slots === null ? (
                <div className="flex h-[34px] items-center rounded-lg border border-slate-100 bg-slate-50 px-2 text-xs text-slate-500">
                  Choose staff, service &amp; date
                </div>
              ) : slots.length === 0 ? (
                <div className="flex h-[34px] items-center rounded-lg border border-rose-100 bg-rose-50 px-2 text-xs text-rose-600">
                  No available times
                </div>
              ) : (
                <select
                  required
                  value={values.time}
                  onChange={(e) => setValues({ ...values, time: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 font-mono text-xs text-slate-700"
                >
                  {slots.map((s) => (
                    <option key={s} value={s}>
                      {s}
                      {activeService ? ` – ${formatEndTime(s, activeService.durationMinutes)}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          {activeService && values.time && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
              Ends at{' '}
              <span className="font-mono text-slate-700">
                {formatEndTime(values.time, activeService.durationMinutes)}
              </span>{' '}
              · price snapshot ${activeService.price}
            </p>
          )}
          <Field label="Notes">
            <textarea
              value={values.notes}
              onChange={(e) => setValues({ ...values, notes: e.target.value })}
              rows={2}
              className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
            />
          </Field>

          {error && <StatusMessage tone="error">{error}</StatusMessage>}

          <div className="flex items-center justify-end gap-2 pt-3">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending || !canSubmit}
              className={`rounded-xl px-4 py-2 text-xs font-semibold text-white transition disabled:opacity-50 ${
                accent === 'teal'
                  ? 'bg-teal-700 hover:bg-teal-800'
                  : 'bg-pink-600 hover:bg-pink-700'
              }`}
            >
              {isPending ? 'Booking…' : 'Confirm Booking'}
            </button>
          </div>
        </form>
      </motion.div>
    </ModalShell>
  );
}

// -----------------------------------------------------------------------------
// Tiny utilities
// -----------------------------------------------------------------------------
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-bold text-slate-500">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

function StatusButton({
  children,
  className,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  className: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

function formatFriendly(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso + 'T00:00Z'));
}

function formatEndTime(hhmm: string, durationMinutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + durationMinutes;
  const h2 = Math.floor(total / 60) % 24;
  const m2 = total % 60;
  return `${String(h2).padStart(2, '0')}:${String(m2).padStart(2, '0')}`;
}
