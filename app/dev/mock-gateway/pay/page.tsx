import { notFound } from 'next/navigation';
import { CreditCard, ShieldCheck } from 'lucide-react';
import { approveAction, declineAction } from './actions';

export const dynamic = 'force-dynamic';

// Stand-in for a real Georgian gateway's Hosted Payment Page. Only served when
// PAYMENT_GATEWAY=mock; hidden in production via notFound().
export default async function MockGatewayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if ((process.env.PAYMENT_GATEWAY ?? 'mock') !== 'mock') notFound();

  const sp = await searchParams;
  const s = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');
  const paymentId = s('paymentId');
  const gatewayTxnId = s('gatewayTxnId');
  const amount = s('amount');
  const currency = s('currency');
  const summary = s('summary');
  const callback = s('callback');
  const webhook = s('webhook');
  if (!paymentId || !gatewayTxnId || !webhook) notFound();

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-800 p-8 text-slate-100 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-xl bg-slate-700 p-2">
            <CreditCard className="h-5 w-5 text-slate-200" />
          </div>
          <div>
            <p className="font-mono text-[10px] tracking-widest text-slate-400 uppercase">
              Mock Gateway
            </p>
            <h1 className="text-lg font-extrabold">Confirm your payment</h1>
          </div>
        </div>

        <div className="mb-6 space-y-2 rounded-xl bg-slate-900/60 p-4 text-sm">
          <div className="flex justify-between text-slate-300">
            <span>Amount</span>
            <span className="font-mono font-bold text-white">
              {amount} {currency}
            </span>
          </div>
          <div className="flex justify-between text-slate-400">
            <span>For</span>
            <span className="max-w-[60%] truncate text-right text-xs">{summary}</span>
          </div>
          <div className="flex justify-between text-slate-500">
            <span>Txn id</span>
            <span className="font-mono text-[11px]">{gatewayTxnId}</span>
          </div>
        </div>

        <p className="mb-4 flex items-center gap-2 rounded-lg bg-slate-900/60 p-3 text-[11px] text-slate-400">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
          Dev-only mock. No real cards accepted. Signed with PAYMENT_MOCK_SECRET.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <form action={declineAction}>
            <HiddenFields
              paymentId={paymentId}
              gatewayTxnId={gatewayTxnId}
              callback={callback}
              webhook={webhook}
            />
            <button
              type="submit"
              className="w-full rounded-xl border border-slate-600 bg-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-600"
            >
              Decline
            </button>
          </form>
          <form action={approveAction}>
            <HiddenFields
              paymentId={paymentId}
              gatewayTxnId={gatewayTxnId}
              callback={callback}
              webhook={webhook}
            />
            <button
              type="submit"
              className="w-full rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-bold text-slate-900 hover:bg-emerald-400"
            >
              Approve
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

function HiddenFields({
  paymentId,
  gatewayTxnId,
  callback,
  webhook,
}: {
  paymentId: string;
  gatewayTxnId: string;
  callback: string;
  webhook: string;
}) {
  return (
    <>
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="gatewayTxnId" value={gatewayTxnId} />
      <input type="hidden" name="callback" value={callback} />
      <input type="hidden" name="webhook" value={webhook} />
    </>
  );
}
