'use client';

import { useState, useTransition, useId } from 'react';
import { AlertTriangle, Sparkles, X } from 'lucide-react';
import { motion } from 'motion/react';
import { draftAppointmentAction } from './actions';
import ModalShell from '@/components/ui/ModalShell';

type PrefillPayload = {
  customerId: string | null;
  staffId: string | null;
  serviceId: string | null;
  date: string;
  time: string;
  notes: string;
};

const SAMPLES = [
  'book Sarah Jenkins with Rachel Kross tomorrow at 3pm',
  'book Michael Chen with Dr. Vance next Monday morning',
  'schedule Elena Rostova with Chloe for a balayage on Friday at 11am',
];

export default function AssistantModal({
  locationId,
  accent,
  onCancel,
  onConfirm,
  onEdit,
}: {
  locationId: string;
  accent: 'teal' | 'pink';
  onCancel: () => void;
  onConfirm: (draft: {
    customerId: string;
    staffId: string;
    serviceId: string;
    startsAt: string;
    notes: string | null;
  }) => void;
  onEdit: (prefill: PrefillPayload) => void;
}) {
  const dlgTitleId = useId();
  const [prompt, setPrompt] = useState('');
  const [draft, setDraft] = useState<null | {
    customerId: string | null;
    customerName: string;
    staffId: string | null;
    staffName: string;
    serviceId: string | null;
    serviceName: string;
    startsAt: string;
    notes: string | null;
    warnings: string[];
  }>(null);
  const [clarify, setClarify] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = (text: string) => {
    setError(null);
    setDraft(null);
    setClarify(null);
    startTransition(async () => {
      try {
        const result = await draftAppointmentAction(locationId, text);
        if (result.status === 'clarify') setClarify(result.question);
        else setDraft(result.draft);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const canConfirm =
    draft && draft.customerId && draft.staffId && draft.serviceId && draft.warnings.length === 0;
  const canEdit = !!draft;

  return (
    <ModalShell titleId={dlgTitleId} panelClassName={null} onDismiss={onCancel}>
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-slate-100 p-1.5 text-slate-500">
              <Sparkles className="h-4 w-4" />
            </div>
            <h2 id={dlgTitleId} className="text-base font-bold text-slate-800">
              Booking assistant
            </h2>
          </div>
          <button
            onClick={onCancel}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(prompt);
          }}
          className="space-y-2"
        >
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-slate-500">
              Describe the appointment
            </span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder='Try: "book Sarah Jenkins with Rachel Kross tomorrow at 3pm"'
              className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1"
              required
            />
          </label>
          <div className="flex flex-wrap gap-1">
            {SAMPLES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setPrompt(s)}
                className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100"
              >
                {s}
              </button>
            ))}
          </div>
          <button
            type="submit"
            disabled={isPending || prompt.trim().length < 3}
            className={`mt-2 w-full rounded-lg px-4 py-2 text-xs font-bold text-white transition disabled:opacity-40 ${
              accent === 'teal' ? 'bg-teal-600 hover:bg-teal-700' : 'bg-pink-600 hover:bg-pink-700'
            }`}
          >
            {isPending ? 'Drafting…' : 'Draft appointment'}
          </button>
        </form>

        {error && (
          <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
        )}

        {clarify && (
          <div className="mt-4 rounded-lg border border-amber-100 bg-amber-50/50 p-3 text-[11px] text-amber-900">
            <p className="font-bold">Need more info</p>
            <p className="mt-1">{clarify}</p>
          </div>
        )}

        {draft && (
          <div className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <p className="font-mono text-[10px] tracking-wider text-slate-400 uppercase">Draft</p>
            <dl className="grid grid-cols-2 gap-2 text-[11px]">
              <DraftField
                label="Patient"
                value={draft.customerName || '—'}
                missing={!draft.customerId}
              />
              <DraftField label="Staff" value={draft.staffName || '—'} missing={!draft.staffId} />
              <DraftField
                label="Service"
                value={draft.serviceName || '—'}
                missing={!draft.serviceId}
              />
              <DraftField
                label="When (UTC)"
                value={`${draft.startsAt.slice(0, 10)} ${draft.startsAt.slice(11, 16)}`}
              />
            </dl>
            {draft.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-100 bg-amber-50 p-2 text-[11px] text-amber-900">
                {draft.warnings.map((w, i) => (
                  <p key={i} className="flex items-start gap-1">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    {w}
                  </p>
                ))}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => {
                  if (!canEdit) return;
                  const startsAt = new Date(draft.startsAt);
                  onEdit({
                    customerId: draft.customerId,
                    staffId: draft.staffId,
                    serviceId: draft.serviceId,
                    date: startsAt.toISOString().slice(0, 10),
                    time: startsAt.toISOString().slice(11, 16),
                    notes: draft.notes ?? '',
                  });
                }}
                disabled={!canEdit}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                Edit in booking form
              </button>
              <button
                onClick={() =>
                  canConfirm &&
                  onConfirm({
                    customerId: draft.customerId!,
                    staffId: draft.staffId!,
                    serviceId: draft.serviceId!,
                    startsAt: draft.startsAt,
                    notes: draft.notes,
                  })
                }
                disabled={!canConfirm}
                className={`rounded-lg px-3 py-1.5 text-[11px] font-bold text-white transition disabled:opacity-40 ${
                  accent === 'teal'
                    ? 'bg-teal-600 hover:bg-teal-700'
                    : 'bg-pink-600 hover:bg-pink-700'
                }`}
              >
                Confirm booking
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </ModalShell>
  );
}

function DraftField({
  label,
  value,
  missing,
}: {
  label: string;
  value: string;
  missing?: boolean;
}) {
  return (
    <div>
      <dt className="font-mono text-[9px] tracking-wider text-slate-400 uppercase">{label}</dt>
      <dd className={`mt-0.5 font-medium ${missing ? 'text-rose-600' : 'text-slate-800'}`}>
        {value}
      </dd>
    </div>
  );
}
