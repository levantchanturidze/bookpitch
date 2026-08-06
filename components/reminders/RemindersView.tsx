'use client';

import { useMemo, useState, useTransition } from 'react';
import type { MessageChannel, MessageState } from '@prisma/client';
import { Clock, MailCheck, MessageSquare, Play, Send, ShieldCheck } from 'lucide-react';
import {
  DEFAULT_EMAIL_TEMPLATE,
  DEFAULT_SMS_TEMPLATE,
  PLACEHOLDER_KEYS,
  renderTemplate,
  type TemplateVars,
} from '@/lib/messaging/templates';
import {
  runRetentionTickAction,
  runTickAction,
  saveLeadHoursAction,
  saveRetentionYearsAction,
  saveTemplateAction,
  sendNowAction,
} from './actions';

type UpcomingAppointment = {
  id: string;
  startsAt: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  serviceName: string;
  staffName: string;
};

type LogEntry = {
  id: string;
  channel: MessageChannel;
  state: MessageState;
  toAddress: string;
  providerMsgId: string | null;
  sentAt: string | null;
  createdAt: string;
  appointmentId: string | null;
  customerName: string | null;
};

type Props = {
  leadHours: number;
  retentionYears: number;
  smsBody: string | null;
  emailBody: string | null;
  upcoming: UpcomingAppointment[];
  log: LogEntry[];
  sampleVars: TemplateVars;
  canRunTick: boolean;
};

const SAMPLE_HINT: TemplateVars = {
  PatientName: 'Sample Patient',
  StaffName: 'Sample Practitioner',
  ServiceName: 'Sample Service',
  Date: '2026-08-01',
  Time: '10:00',
};

export default function RemindersView({
  leadHours,
  retentionYears,
  smsBody,
  emailBody,
  upcoming,
  log,
  sampleVars,
  canRunTick,
}: Props) {
  const previewVars = { ...SAMPLE_HINT, ...sampleVars };

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-extrabold tracking-tight text-slate-900">Reminders</h2>
            <p className="mt-1 text-xs text-slate-500">
              SMS + email templates, per-org lead time, and a live send log.
            </p>
          </div>
          <LeadHoursForm initial={leadHours} />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <TemplateCard
          channel="sms"
          initial={smsBody ?? DEFAULT_SMS_TEMPLATE}
          previewVars={previewVars}
        />
        <TemplateCard
          channel="email"
          initial={emailBody ?? DEFAULT_EMAIL_TEMPLATE}
          previewVars={previewVars}
        />
      </div>

      <UpcomingCard upcoming={upcoming} canRunTick={canRunTick} />

      <LogCard log={log} />

      {canRunTick && <RetentionCard initial={retentionYears} />}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Lead hours form
// -----------------------------------------------------------------------------
function LeadHoursForm({ initial }: { initial: number }) {
  const [value, setValue] = useState(String(initial));
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={(fd) => startTransition(() => saveLeadHoursAction(fd))}
      className="flex items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
    >
      <label className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
        Lead time
        <div className="mt-1 flex items-center gap-1">
          <input
            name="hours"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            type="number"
            min={1}
            max={168}
            className="w-16 rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm font-bold text-slate-800"
          />
          <span className="text-[11px] text-slate-500">hours before</span>
        </div>
      </label>
      <button
        type="submit"
        disabled={isPending || value === String(initial)}
        className="rounded-lg bg-slate-900 px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-slate-800 disabled:opacity-40"
      >
        {isPending ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

// -----------------------------------------------------------------------------
// One template editor (used twice — SMS + email)
// -----------------------------------------------------------------------------
function TemplateCard({
  channel,
  initial,
  previewVars,
}: {
  channel: MessageChannel;
  initial: string;
  previewVars: TemplateVars;
}) {
  const [body, setBody] = useState(initial);
  const [isPending, startTransition] = useTransition();
  const preview = useMemo(() => renderTemplate(body, previewVars), [body, previewVars]);
  const isSms = channel === 'sms';
  const Icon = isSms ? MessageSquare : MailCheck;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`rounded-lg p-2 ${isSms ? 'bg-indigo-50 text-indigo-600' : 'bg-amber-50 text-amber-600'}`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-bold text-slate-800">
            {isSms ? 'SMS Template' : 'Email Template'}
          </h3>
        </div>
        <div className="font-mono text-[10px] text-slate-400">{body.length} chars</div>
      </div>

      <form action={(fd) => startTransition(() => saveTemplateAction(fd))} className="space-y-3">
        <input type="hidden" name="channel" value={channel} />
        <textarea
          name="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={isSms ? 4 : 8}
          className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[12px] text-slate-800 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-1">
          {PLACEHOLDER_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setBody((prev) => `${prev}{${k}}`)}
              className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[10px] text-slate-600 hover:bg-slate-100"
            >
              {'{' + k + '}'}
            </button>
          ))}
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="w-full rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white transition hover:bg-slate-800 disabled:opacity-40"
        >
          {isPending ? 'Saving…' : 'Save template'}
        </button>
      </form>

      <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-3">
        <p className="mb-1 font-mono text-[10px] tracking-wider text-slate-400 uppercase">
          Preview (sample data)
        </p>
        <pre className="font-sans text-[12px] whitespace-pre-wrap text-slate-700">{preview}</pre>
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Upcoming appointments list — Send now per row
// -----------------------------------------------------------------------------
function UpcomingCard({
  upcoming,
  canRunTick,
}: {
  upcoming: UpcomingAppointment[];
  canRunTick: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      <header className="flex items-center justify-between border-b border-slate-100 px-6 py-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-slate-500" />
          <h3 className="font-mono text-[10px] font-bold tracking-widest text-slate-500 uppercase">
            Upcoming in reminder window — {upcoming.length}
          </h3>
        </div>
        {canRunTick && (
          <form action={() => startTransition(() => runTickAction())}>
            <button
              type="submit"
              disabled={isPending}
              className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
            >
              <Play className="h-3 w-3" />
              {isPending ? 'Running…' : 'Run reminder tick'}
            </button>
          </form>
        )}
      </header>
      {upcoming.length === 0 ? (
        <p className="px-6 py-8 text-center text-xs text-slate-400">
          No appointments within the current lead-time window.
        </p>
      ) : (
        <div className="divide-y divide-slate-100">
          {upcoming.map((a) => (
            <UpcomingRow key={a.id} appointment={a} />
          ))}
        </div>
      )}
    </section>
  );
}

function UpcomingRow({ appointment: a }: { appointment: UpcomingAppointment }) {
  const [isPending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-3 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-bold text-slate-800">{a.customerName}</p>
        <p className="mt-0.5 truncate text-[11px] text-slate-500">
          {a.serviceName} · {a.staffName}
        </p>
        <p className="mt-0.5 font-mono text-[10px] text-slate-400">
          {a.startsAt.slice(0, 10)} {a.startsAt.slice(11, 16)} UTC ·{' '}
          <span className={a.customerPhone ? 'text-slate-500' : 'text-rose-500'}>
            {a.customerPhone ?? 'no phone'}
          </span>{' '}
          ·{' '}
          <span className={a.customerEmail ? 'text-slate-500' : 'text-rose-500'}>
            {a.customerEmail ?? 'no email'}
          </span>
        </p>
      </div>
      <form action={(fd) => startTransition(() => sendNowAction(fd))} className="shrink-0">
        <input type="hidden" name="appointmentId" value={a.id} />
        <button
          type="submit"
          disabled={isPending}
          className="flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-slate-800 disabled:opacity-40"
        >
          <Send className="h-3 w-3" />
          {isPending ? 'Sending…' : 'Send now'}
        </button>
      </form>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Recent send log
// -----------------------------------------------------------------------------
const STATE_BADGE: Record<MessageState, string> = {
  queued: 'bg-slate-100 text-slate-600 border-slate-200',
  sent: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  delivered: 'bg-blue-50 text-blue-700 border-blue-100',
  failed: 'bg-rose-50 text-rose-700 border-rose-100',
};

function LogCard({ log }: { log: LogEntry[] }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      <header className="border-b border-slate-100 px-6 py-3">
        <h3 className="font-mono text-[10px] font-bold tracking-widest text-slate-500 uppercase">
          Recent sends — {log.length}
        </h3>
      </header>
      {log.length === 0 ? (
        <p className="px-6 py-8 text-center text-xs text-slate-400">
          No reminders sent yet. Save a template and click Send now on an upcoming appointment.
        </p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-100 bg-slate-50 font-mono text-[10px] tracking-wider text-slate-500 uppercase">
            <tr>
              <th className="px-6 py-2 font-medium">When</th>
              <th className="px-2 py-2 font-medium">Channel</th>
              <th className="px-2 py-2 font-medium">Recipient</th>
              <th className="px-2 py-2 font-medium">Customer</th>
              <th className="px-2 py-2 font-medium">Provider msg id</th>
              <th className="px-6 py-2 font-medium">State</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {log.map((row) => (
              <tr key={row.id}>
                <td className="px-6 py-2 font-mono text-[11px] text-slate-500">
                  {(row.sentAt ?? row.createdAt).slice(11, 19)}
                </td>
                <td className="px-2 py-2 font-mono text-[11px]">{row.channel}</td>
                <td className="px-2 py-2 font-mono text-[11px] text-slate-700">
                  {row.toAddress || '—'}
                </td>
                <td className="px-2 py-2 text-slate-700">{row.customerName ?? '—'}</td>
                <td className="px-2 py-2 font-mono text-[10px] text-slate-500">
                  {row.providerMsgId ?? '—'}
                </td>
                <td className="px-6 py-2">
                  <span
                    className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${STATE_BADGE[row.state]}`}
                  >
                    {row.state}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Retention (owner-only). Sets the customer PII retention window and can run
// the retention tick manually. Real prod deploy hooks POST /api/cron/retention
// on a daily schedule via Vercel Cron / GitHub Actions.
// -----------------------------------------------------------------------------
function RetentionCard({ initial }: { initial: number }) {
  const [years, setYears] = useState(String(initial));
  const [isPendingSave, startSave] = useTransition();
  const [isPendingTick, startTick] = useTransition();
  return (
    <section className="rounded-2xl border border-amber-100 bg-amber-50/40 p-6">
      <div className="mb-3 flex items-center gap-2">
        <div className="rounded-lg bg-amber-50 p-2 text-amber-700">
          <ShieldCheck className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-slate-800">Customer PII retention</h3>
          <p className="text-[11px] text-slate-500">
            Customers idle beyond this window are anonymized when the retention tick runs.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <form
          action={(fd) => startSave(() => saveRetentionYearsAction(fd))}
          className="flex items-end gap-2"
        >
          <label className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">
            Retention
            <div className="mt-1 flex items-center gap-1">
              <input
                name="years"
                value={years}
                onChange={(e) => setYears(e.target.value)}
                type="number"
                min={1}
                max={30}
                className="w-16 rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm font-bold text-slate-800"
              />
              <span className="text-[11px] text-slate-500">years</span>
            </div>
          </label>
          <button
            type="submit"
            disabled={isPendingSave || years === String(initial)}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-slate-800 disabled:opacity-40"
          >
            {isPendingSave ? 'Saving…' : 'Save'}
          </button>
        </form>
        <form action={() => startTick(() => runRetentionTickAction())} className="ml-auto">
          <button
            type="submit"
            disabled={isPendingTick}
            className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
          >
            <Play className="h-3 w-3" />
            {isPendingTick ? 'Running…' : 'Run retention tick'}
          </button>
        </form>
      </div>
    </section>
  );
}
