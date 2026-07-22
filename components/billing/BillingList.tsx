import { Banknote, CreditCard, Receipt, ShieldCheck } from 'lucide-react';
import type { AppointmentStatus, PaymentStatus } from '@prisma/client';
import { settleCashAction, startCardCheckoutAction } from './actions';

// -----------------------------------------------------------------------------
// Server component (rendered inside the /billing server page). Server Actions
// mean we don't need client state for the buttons — each `<form action>` posts
// straight to the action, then the layout revalidates and re-renders.
// -----------------------------------------------------------------------------

export type BillingRow = {
  id: string;
  date: string;
  time: string;
  customerName: string;
  serviceName: string;
  staffName: string;
  price: number;
  status: AppointmentStatus;
  paymentStatus: PaymentStatus;
  lastPaymentMethod: string | null;
};

export default function BillingList({
  location,
  rows,
}: {
  location: { name: string; type: 'clinic' | 'salon' };
  rows: BillingRow[];
}) {
  const unpaid = rows.filter((r) => r.paymentStatus === 'unpaid');
  const paid = rows.filter((r) => r.paymentStatus === 'paid');
  const isClinic = location.type === 'clinic';

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-6">
        <div className={`rounded-xl p-3 ${isClinic ? 'bg-teal-50 text-teal-600' : 'bg-pink-50 text-pink-600'}`}>
          <Receipt className="h-6 w-6" />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-extrabold tracking-tight text-slate-900">Billing & POS</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {location.name} · card payments go through the configured gateway; cash settles instantly.
          </p>
        </div>
        <div className="hidden text-right sm:block">
          <p className="font-mono text-[10px] tracking-wider text-slate-400 uppercase">
            Outstanding
          </p>
          <p className="text-2xl font-extrabold text-slate-900">
            {unpaid.reduce((sum, r) => sum + r.price, 0).toFixed(2)}
            <span className="ml-1 font-mono text-xs font-normal text-slate-400">GEL</span>
          </p>
        </div>
      </header>

      <Section title={`Outstanding — ${unpaid.length}`} empty="No unpaid appointments.">
        {unpaid.map((r) => (
          <UnpaidRow key={r.id} row={r} />
        ))}
      </Section>

      <Section title={`Recently paid — ${paid.length}`} empty="No paid appointments yet.">
        {paid.map((r) => (
          <PaidRow key={r.id} row={r} />
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  const hasItems = items.some((c) => c);
  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      <h3 className="border-b border-slate-100 px-6 py-3 font-mono text-[10px] font-bold tracking-widest text-slate-500 uppercase">
        {title}
      </h3>
      {hasItems ? (
        <div className="divide-y divide-slate-100">{children}</div>
      ) : (
        <p className="px-6 py-8 text-center text-xs text-slate-400">{empty}</p>
      )}
    </section>
  );
}

function UnpaidRow({ row }: { row: BillingRow }) {
  return (
    <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-slate-800">{row.customerName}</p>
        <p className="mt-0.5 truncate text-xs text-slate-500">
          {row.serviceName} · with <span className="font-medium">{row.staffName}</span>
        </p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-400">
          {row.date} at {row.time}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <p className="text-lg font-extrabold text-slate-900">
          {row.price.toFixed(2)}
          <span className="ml-1 font-mono text-xs font-normal text-slate-400">GEL</span>
        </p>
        <form action={settleCashAction}>
          <input type="hidden" name="appointmentId" value={row.id} />
          <button
            type="submit"
            className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            <Banknote className="h-3.5 w-3.5" /> Cash
          </button>
        </form>
        <form action={startCardCheckoutAction}>
          <input type="hidden" name="appointmentId" value={row.id} />
          <button
            type="submit"
            className="flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-800"
          >
            <CreditCard className="h-3.5 w-3.5" /> Pay by card
          </button>
        </form>
      </div>
    </div>
  );
}

function PaidRow({ row }: { row: BillingRow }) {
  return (
    <div className="flex items-center justify-between px-6 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-bold text-slate-700">{row.customerName}</p>
        <p className="mt-0.5 truncate text-[11px] text-slate-500">
          {row.serviceName} · {row.date} {row.time}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1 rounded-full border border-emerald-100 bg-emerald-50 px-2 py-0.5 font-mono text-[10px] text-emerald-700">
          <ShieldCheck className="h-3 w-3" />
          {row.lastPaymentMethod ?? 'paid'}
        </span>
        <span className="text-xs font-bold text-slate-800">
          {row.price.toFixed(2)}
          <span className="ml-1 font-mono text-[10px] font-normal text-slate-400">GEL</span>
        </span>
      </div>
    </div>
  );
}
