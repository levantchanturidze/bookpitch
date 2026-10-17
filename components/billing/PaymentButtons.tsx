'use client';

import { useState, useTransition } from 'react';
import { Banknote, CreditCard } from 'lucide-react';
import { resultMessage, type ActionResult } from '@/lib/action-result';
import StatusMessage from '@/components/ui/StatusMessage';
import { settleCashAction, startCardCheckoutAction } from './actions';

/**
 * The two payment buttons for one unpaid appointment.
 *
 * They were bare `<form action={…}>` elements in a server component, which
 * discards whatever the action returns — fine while a refusal was a thrown
 * error (it reached the error page), silent once actions return typed results.
 * So the result is read here and its message shown. The card action normally
 * ends in a redirect to the gateway, in which case there is no result to read.
 */
export default function PaymentButtons({ appointmentId }: { appointmentId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const run = (action: (fd: FormData) => Promise<ActionResult>) => (fd: FormData) =>
    startTransition(async () => {
      const result = await action(fd);
      setError(result ? resultMessage(result) : null);
    });

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-3">
        <form action={run(settleCashAction)}>
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <button
            type="submit"
            disabled={isPending}
            className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
          >
            <Banknote className="h-3.5 w-3.5" /> Cash
          </button>
        </form>
        <form action={run(startCardCheckoutAction)}>
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <button
            type="submit"
            disabled={isPending}
            className="flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-800 disabled:opacity-40"
          >
            <CreditCard className="h-3.5 w-3.5" /> Pay by card
          </button>
        </form>
      </div>
      <StatusMessage tone="error">{error}</StatusMessage>
    </div>
  );
}
