'use client';

import { useMemo, useState, useTransition, useId } from 'react';
import {
  Calendar,
  Download,
  Info,
  Mail,
  Phone,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserPlus,
  UserX,
  X,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

import type { CustomerDetailDto } from '@/lib/customers';
import ModalShell from '@/components/ui/ModalShell';
import StatusMessage from '@/components/ui/StatusMessage';
import {
  addTreatmentHistoryAction,
  anonymizeCustomerAction,
  createCustomerAction,
  deleteCustomerAction,
  exportCustomerAction,
  updateCustomerAction,
} from './actions';

type Props = {
  customers: CustomerDetailDto[];
  locationType: 'clinic' | 'salon';
  isOwner: boolean;
};

type FormState = {
  name: string;
  email: string;
  phone: string;
  dob: string;
  gender: string;
  allergies: string;
  clinicalNotes: string;
  consent: boolean;
};

const EMPTY_FORM: FormState = {
  name: '',
  email: '',
  phone: '',
  dob: '',
  gender: 'Female',
  allergies: '',
  clinicalNotes: '',
  consent: false,
};

export default function PatientList({ customers, locationType, isOwner }: Props) {
  const dlgTitleId = useId();
  const isClinic = locationType === 'clinic';
  const accent = isClinic ? 'teal' : 'pink';
  const labelSingular = isClinic ? 'Patient' : 'Client';
  const labelPlural = isClinic ? 'Patients' : 'Clients';

  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>(customers[0]?.id);
  const [formOpen, setFormOpen] = useState<false | 'create' | 'edit'>(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) =>
      `${c.name} ${c.phone ?? ''} ${c.email ?? ''}`.toLowerCase().includes(q),
    );
  }, [customers, search]);

  const active = useMemo(
    () => customers.find((c) => c.id === selectedId) ?? customers[0],
    [customers, selectedId],
  );

  const handleCreate = (values: FormState) => {
    setError(null);
    startTransition(async () => {
      try {
        const created = await createCustomerAction({
          name: values.name,
          email: values.email || null,
          phone: values.phone || null,
          dob: values.dob || null,
          gender: values.gender || null,
          allergies: values.allergies || null,
          clinicalNotes: values.clinicalNotes || null,
          consent: values.consent,
        });
        setSelectedId(created.id);
        setFormOpen(false);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const handleUpdate = (id: string, values: FormState) => {
    setError(null);
    startTransition(async () => {
      try {
        await updateCustomerAction(id, {
          name: values.name,
          email: values.email || null,
          phone: values.phone || null,
          dob: values.dob || null,
          gender: values.gender || null,
          allergies: values.allergies || null,
          clinicalNotes: values.clinicalNotes || null,
          consent: values.consent || undefined,
        });
        setFormOpen(false);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const handleDelete = (id: string) => {
    setError(null);
    startTransition(async () => {
      const res = await deleteCustomerAction(id);
      if (!res.ok) {
        setError(
          res.reason === 'has_appointments'
            ? 'Cannot delete: this profile has appointment history.'
            : 'Profile not found.',
        );
        return;
      }
      setConfirmDeleteId(null);
      if (selectedId === id) setSelectedId(undefined);
    });
  };

  const handleAddHistory = (customerId: string, label: string) => {
    setError(null);
    startTransition(async () => {
      try {
        await addTreatmentHistoryAction(customerId, label);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* ----------------------- LIST PANE ------------------------------- */}
      <div className="flex h-[580px] flex-col rounded-xl border border-slate-200 bg-white p-5 lg:col-span-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-slate-800">{labelPlural} Database</h3>
            <p className="text-[10px] text-slate-500">
              {customers.length} registered · {filtered.length} shown
            </p>
          </div>
          <button
            onClick={() => setFormOpen('create')}
            className={`flex items-center gap-1.5 rounded-xl p-2 text-xs font-semibold text-white shadow-sm transition ${
              accent === 'teal' ? 'bg-teal-700 hover:bg-teal-800' : 'bg-pink-600 hover:bg-pink-700'
            }`}
          >
            <UserPlus className="h-4 w-4" />
            <span className="hidden sm:inline">Add {labelSingular}</span>
          </button>
        </div>

        <div className="relative mb-4">
          <Search className="absolute top-2.5 left-3 h-4 w-4 text-slate-500" />
          <input
            type="text"
            placeholder={`Search ${labelPlural.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pr-4 pl-9 text-xs text-slate-700 focus:ring-1 focus:ring-slate-400 focus:outline-none"
          />
        </div>

        {error && (
          <StatusMessage tone="error" className="mb-3">
            {error}
          </StatusMessage>
        )}

        <div className="flex-1 space-y-2 overflow-y-auto pr-1">
          {filtered.length === 0 && (
            <div className="flex flex-col items-center py-12 text-center text-slate-500">
              <Search className="mb-2 h-8 w-8 stroke-1 text-slate-300" aria-hidden="true" />
              <p className="text-xs">No records match your search.</p>
            </div>
          )}
          {filtered.map((c) => {
            const isSelected = c.id === active?.id;
            const hasAllergyFlag = !!c.allergies && c.allergies.toLowerCase() !== 'none';
            return (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
                  isSelected
                    ? accent === 'teal'
                      ? 'border-teal-200 bg-teal-50/70 text-teal-900 shadow-sm'
                      : 'border-pink-200 bg-pink-50/70 text-pink-900 shadow-sm'
                    : 'border-slate-100 bg-white hover:border-slate-200'
                }`}
              >
                <Avatar name={c.name} url={c.avatarUrl} />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-bold">{c.name}</span>
                  <span className="block font-mono text-[10px] text-slate-500">
                    {c.phone ?? '—'}
                  </span>
                </div>
                {hasAllergyFlag && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-rose-500"
                    title="Allergies / warnings present"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ----------------------- DETAIL PANE ----------------------------- */}
      <div className="flex h-[580px] flex-col rounded-xl border border-slate-200 bg-white p-6 lg:col-span-7">
        {active ? (
          <PatientDetail
            active={active}
            isClinic={isClinic}
            accent={accent}
            isOwner={isOwner}
            onEdit={() => setFormOpen('edit')}
            onDelete={() => setConfirmDeleteId(active.id)}
            onAddHistory={(label) => handleAddHistory(active.id, label)}
            isPending={isPending}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-slate-500">
            <Info className="mb-2 h-10 w-10 stroke-1 text-slate-300" aria-hidden="true" />
            <p className="text-xs">Select a {labelSingular.toLowerCase()} to inspect details.</p>
          </div>
        )}
      </div>

      {/* ----------------------- CREATE / EDIT DRAWER -------------------- */}
      <AnimatePresence>
        {formOpen && (
          <PatientFormModal
            mode={formOpen}
            initial={formOpen === 'edit' && active ? active : null}
            labelSingular={labelSingular}
            isClinic={isClinic}
            accent={accent}
            isPending={isPending}
            error={error}
            onCancel={() => {
              setFormOpen(false);
              setError(null);
            }}
            onSubmit={(values) => {
              if (formOpen === 'create') handleCreate(values);
              else if (active) handleUpdate(active.id, values);
            }}
          />
        )}
      </AnimatePresence>

      {/* ----------------------- DELETE CONFIRM -------------------------- */}
      <AnimatePresence>
        {confirmDeleteId && (
          <ModalShell titleId={dlgTitleId} panelClassName={null}>
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
            >
              <h2 id={dlgTitleId} className="text-base font-bold text-slate-800">
                Delete {labelSingular} Profile?
              </h2>
              <p className="mt-2 text-xs text-slate-500">
                This action is permanent. Profiles with existing appointments cannot be deleted
                until soft-delete lands (P3.3).
              </p>
              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirmDeleteId(null)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(confirmDeleteId)}
                  disabled={isPending}
                  className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {isPending ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </motion.div>
          </ModalShell>
        )}
      </AnimatePresence>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Detail pane
// -----------------------------------------------------------------------------
function PatientDetail({
  active,
  isClinic,
  accent,
  isOwner,
  onEdit,
  onDelete,
  onAddHistory,
  isPending,
}: {
  active: CustomerDetailDto;
  isClinic: boolean;
  accent: 'teal' | 'pink';
  isOwner: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onAddHistory: (label: string) => void;
  isPending: boolean;
}) {
  const [historyDraft, setHistoryDraft] = useState('');
  const hasAllergy = !!active.allergies && active.allergies.toLowerCase() !== 'none';

  return (
    <div className="flex flex-1 flex-col overflow-y-auto pr-1">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-slate-100 pb-5 sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          <Avatar name={active.name} url={active.avatarUrl} size="lg" />
          <div>
            <h3 className="text-lg font-bold text-slate-800">{active.name}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-600">
                ID: {active.id.slice(0, 8)}
              </span>
              <span className="font-mono text-[10px] text-slate-500">
                Joined {active.joinedDate}
              </span>
              <ConsentBadge consentAt={active.consentAt} consentVersion={active.consentVersion} />
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={onEdit}
              className={`rounded-lg px-3 py-1.5 text-[11px] font-bold text-white ${
                accent === 'teal'
                  ? 'bg-teal-700 hover:bg-teal-800'
                  : 'bg-pink-600 hover:bg-pink-700'
              }`}
            >
              Edit
            </button>
            <button
              onClick={onDelete}
              className="rounded-lg border border-rose-200 p-1.5 text-rose-500 hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1"
              title="Delete profile"
              aria-label="Delete profile"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5 text-right font-mono text-[11px] text-slate-500">
            <span className="flex items-center justify-end gap-1">
              <Calendar className="h-3.5 w-3.5 text-slate-500" /> DOB: {active.dob ?? '—'}
            </span>
            <span>Gender: {active.gender ?? '—'}</span>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-100 p-4">
            <span className="mb-2 block font-mono text-[10px] font-bold tracking-wider text-slate-500 uppercase">
              Contact Details
            </span>
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2 text-slate-600">
                <Phone className="h-3.5 w-3.5 text-slate-500" /> {active.phone ?? '—'}
              </div>
              <div className="flex items-center gap-2 text-slate-600">
                <Mail className="h-3.5 w-3.5 text-slate-500" /> {active.email ?? '—'}
              </div>
            </div>
          </div>

          <div
            className={`rounded-xl border p-4 ${
              hasAllergy ? 'border-rose-100 bg-rose-50/50' : 'border-slate-100 bg-slate-50/50'
            }`}
          >
            <span className="mb-2 flex items-center gap-1 font-mono text-[10px] font-bold tracking-wider text-slate-600 uppercase">
              <ShieldAlert
                className={`h-3.5 w-3.5 ${hasAllergy ? 'text-rose-500' : 'text-slate-600'}`}
              />
              {isClinic ? 'Contraindications & Allergies' : 'Sensitivities / Warnings'}
            </span>
            <p
              className={`text-xs font-semibold ${hasAllergy ? 'text-rose-800' : 'text-slate-600'}`}
            >
              {active.allergies ?? 'None recorded'}
            </p>
          </div>

          <div className="rounded-xl border border-slate-100 p-4">
            <span className="mb-1 block font-mono text-[10px] font-bold tracking-wider text-slate-500 uppercase">
              {isClinic ? 'Clinical Intake Notes' : 'Stylist Session Notes'}
            </span>
            <p className="font-sans text-xs leading-relaxed text-slate-600">
              {active.clinicalNotes ?? 'No notes yet.'}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex h-[220px] flex-col rounded-xl border border-slate-100 p-4">
            <span className="mb-2 block font-mono text-[10px] font-bold tracking-wider text-slate-500 uppercase">
              Treatment History
            </span>
            <div className="flex-1 space-y-1.5 overflow-y-auto pr-1">
              {active.treatmentHistory.length === 0 ? (
                <p className="text-[11px] text-slate-500 italic">No history logged yet.</p>
              ) : (
                active.treatmentHistory.map((h) => (
                  <div
                    key={h.id}
                    className="rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs text-slate-700"
                  >
                    {h.label}
                  </div>
                ))
              )}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!historyDraft.trim()) return;
                onAddHistory(historyDraft);
                setHistoryDraft('');
              }}
              className="mt-2 flex gap-1"
            >
              <input
                value={historyDraft}
                onChange={(e) => setHistoryDraft(e.target.value)}
                placeholder="e.g. Annual physical (Jan 2026)"
                className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1"
              />
              <button
                type="submit"
                disabled={isPending || !historyDraft.trim()}
                className="rounded-lg bg-slate-900 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1 disabled:opacity-40"
                aria-label="Add history entry"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </form>
          </div>

          <div className="rounded-xl border border-slate-100 p-4">
            <span className="mb-2 block font-mono text-[10px] font-bold tracking-wider text-slate-500 uppercase">
              Visits & Status
            </span>
            <p className="text-[11px] text-slate-500 italic">
              Appointment integration lands in P1.5.
            </p>
          </div>

          {isOwner && <GdprPanel customerId={active.id} customerName={active.name} />}
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// GDPR panel (owner-only) — export PII as JSON, or anonymize the record.
// -----------------------------------------------------------------------------
function GdprPanel({ customerId, customerName }: { customerId: string; customerName: string }) {
  const dlgTitleId2 = useId();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleExport = () => {
    setError(null);
    startTransition(async () => {
      try {
        const data = await exportCustomerAction(customerId);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `customer-${customerId}-export.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const handleAnonymize = () => {
    setError(null);
    startTransition(async () => {
      try {
        await anonymizeCustomerAction(customerId);
        setConfirming(false);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  return (
    <div className="rounded-xl border border-amber-100 bg-amber-50/40 p-4">
      <span className="mb-2 block font-mono text-[10px] font-bold tracking-wider text-amber-800 uppercase">
        GDPR
      </span>
      <p className="mb-3 text-[11px] text-amber-900/80">
        Owner-only. Both actions write to the audit log.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          disabled={isPending}
          onClick={handleExport}
          className="flex items-center gap-1 rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-amber-900 transition hover:bg-amber-50 disabled:opacity-40"
        >
          <Download className="h-3 w-3" />
          Export data
        </button>
        <button
          disabled={isPending}
          onClick={() => setConfirming(true)}
          className="flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-40"
        >
          <UserX className="h-3 w-3" />
          Anonymize (GDPR)
        </button>
      </div>
      {error && (
        <p className="mt-2 rounded-lg bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">{error}</p>
      )}
      <AnimatePresence>
        {confirming && (
          <ModalShell titleId={dlgTitleId2} panelClassName={null}>
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
            >
              <h2 id={dlgTitleId2} className="text-base font-bold text-slate-800">
                Anonymize {customerName}?
              </h2>
              <p className="mt-2 text-xs text-slate-500">
                This redacts name, contact fields, allergies, and clinical notes. Appointment and
                payment history stays intact. The action is logged in the audit trail and cannot be
                undone.
              </p>
              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirming(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAnonymize}
                  disabled={isPending}
                  className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {isPending ? 'Anonymizing…' : 'Anonymize'}
                </button>
              </div>
            </motion.div>
          </ModalShell>
        )}
      </AnimatePresence>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Create / Edit form dialog
// -----------------------------------------------------------------------------
function PatientFormModal({
  mode,
  initial,
  labelSingular,
  isClinic,
  accent,
  isPending,
  error,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial: CustomerDetailDto | null;
  labelSingular: string;
  isClinic: boolean;
  accent: 'teal' | 'pink';
  isPending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (values: FormState) => void;
}) {
  const dlgTitleId3 = useId();
  const [values, setValues] = useState<FormState>(() => {
    if (initial) {
      return {
        name: initial.name,
        email: initial.email ?? '',
        phone: initial.phone ?? '',
        dob: initial.dob ?? '',
        gender: initial.gender ?? 'Female',
        allergies: initial.allergies ?? '',
        clinicalNotes: initial.clinicalNotes ?? '',
        // Edit doesn't re-collect consent by default; owner can opt to refresh.
        consent: false,
      };
    }
    return EMPTY_FORM;
  });

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setValues((prev) => ({ ...prev, [k]: v }));

  return (
    <ModalShell titleId={dlgTitleId3} panelClassName={null} onDismiss={onCancel}>
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2
            id={dlgTitleId3}
            className="flex items-center gap-1.5 text-base font-bold text-slate-800"
          >
            <UserPlus
              className={`h-5 w-5 ${accent === 'teal' ? 'text-teal-600' : 'text-pink-600'}`}
            />
            {mode === 'create'
              ? `Create ${labelSingular} Profile`
              : `Edit ${labelSingular} Profile`}
          </h2>
          <button
            onClick={onCancel}
            className="rounded-lg p-1 text-slate-500 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(values);
          }}
          className="space-y-3"
        >
          <Field label="Full Name *" required>
            <input
              type="text"
              required
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone">
              <input
                type="tel"
                value={values.phone}
                onChange={(e) => set('phone', e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={values.email}
                onChange={(e) => set('email', e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date of Birth">
              <input
                type="date"
                value={values.dob}
                onChange={(e) => set('dob', e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
              />
            </Field>
            <Field label="Gender">
              <select
                value={values.gender}
                onChange={(e) => set('gender', e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
              >
                <option value="Female">Female</option>
                <option value="Male">Male</option>
                <option value="Non-binary">Non-binary</option>
                <option value="Prefer not to say">Prefer not to say</option>
              </select>
            </Field>
          </div>
          <Field
            label={isClinic ? 'Contraindications & Allergies' : 'Skin Concerns & Sensitivities'}
          >
            <input
              type="text"
              value={values.allergies}
              onChange={(e) => set('allergies', e.target.value)}
              placeholder={isClinic ? 'e.g. Penicillin' : 'e.g. Retinol user'}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
            />
          </Field>
          <Field label={isClinic ? 'Clinical Intake Notes' : 'Stylist Notes'}>
            <textarea
              value={values.clinicalNotes}
              onChange={(e) => set('clinicalNotes', e.target.value)}
              rows={3}
              className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
            />
          </Field>

          {/* Consent capture — required to CREATE, optional refresh on EDIT. */}
          <label
            className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${
              values.consent
                ? 'border-emerald-200 bg-emerald-50/60 text-emerald-900'
                : 'border-slate-200 bg-slate-50 text-slate-600'
            }`}
          >
            <input
              type="checkbox"
              checked={values.consent}
              onChange={(e) => set('consent', e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              I confirm the {labelSingular.toLowerCase()} consents to storing health-related data
              (privacy policy v1.0). {mode === 'create' && '(required)'}
            </span>
          </label>

          {error && <StatusMessage tone="error">{error}</StatusMessage>}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending || (mode === 'create' && !values.consent)}
              className={`rounded-xl px-4 py-2 text-xs font-semibold text-white transition disabled:opacity-50 ${
                accent === 'teal'
                  ? 'bg-teal-700 hover:bg-teal-800'
                  : 'bg-pink-600 hover:bg-pink-700'
              }`}
            >
              {isPending ? 'Saving…' : mode === 'create' ? 'Create Profile' : 'Save Changes'}
            </button>
          </div>
        </form>
      </motion.div>
    </ModalShell>
  );
}

// -----------------------------------------------------------------------------
// Tiny presentational bits
// -----------------------------------------------------------------------------
function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold text-slate-500">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </span>
      {children}
    </label>
  );
}

function Avatar({
  name,
  size = 'md',
}: {
  name: string;
  // `url` kept as a no-op prop so call sites don't need updating right
  // now — MVP always renders initials per spec (no file uploads yet).
  url?: string | null;
  size?: 'md' | 'lg';
}) {
  const cls = size === 'lg' ? 'w-16 h-16 rounded-2xl text-lg' : 'w-10 h-10 rounded-full text-xs';
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div
      className={`${cls} flex items-center justify-center border border-slate-200 bg-slate-100 font-mono font-bold text-slate-600`}
    >
      {initials}
    </div>
  );
}

function ConsentBadge({
  consentAt,
  consentVersion,
}: {
  consentAt: string | null;
  consentVersion: string | null;
}) {
  if (!consentAt) {
    return (
      <span className="flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 font-mono text-[10px] text-amber-700">
        <ShieldAlert className="h-3 w-3" /> No consent
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 font-mono text-[10px] text-emerald-700">
      <ShieldCheck className="h-3 w-3" /> Consent v{consentVersion} · {consentAt.slice(0, 10)}
    </span>
  );
}
