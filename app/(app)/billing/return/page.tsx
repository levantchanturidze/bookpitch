import Link from 'next/link';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withOrg } from '@/lib/db';

export const metadata = { title: 'Payment · Bookpitch' };
export const dynamic = 'force-dynamic';

// Gateway callback landing page. The webhook is the source of truth; this
// page just renders whatever the DB currently says. On slow gateways the row
// may still be `unpaid` for a moment — a small auto-refresh handles that.
export default async function BillingReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAuthContext();
  requirePermission(
    ctx,
    'payment.charge',
    { organizationId: ctx.activeOrganizationId! },
    'billing',
  );
  const session = ctxToSession(ctx);
  const sp = await searchParams;
  const paymentId = typeof sp.paymentId === 'string' ? sp.paymentId : '';

  const payment = paymentId
    ? await withOrg(session.organizationId, (tx) =>
        tx.payment.findUnique({
          where: { id: paymentId },
          include: {
            appointment: {
              include: {
                customer: { select: { name: true } },
              },
            },
          },
        }),
      )
    : null;

  const status = payment?.status ?? 'unknown';

  return (
    <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      {status === 'paid' ? (
        <>
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <CheckCircle2 className="h-6 w-6 stroke-[2.5]" />
          </div>
          <h1 className="text-base font-extrabold text-slate-900">Payment received</h1>
          <p className="mt-2 text-xs text-slate-500">
            {payment?.appointment?.customer.name}&apos;s {payment?.appointment?.serviceName} is
            settled.
          </p>
        </>
      ) : status === 'unpaid' ? (
        <>
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600">
            <Clock className="h-6 w-6 stroke-[2.5]" />
          </div>
          <h1 className="text-base font-extrabold text-slate-900">Waiting for confirmation</h1>
          <p className="mt-2 text-xs text-slate-500">
            The gateway is still processing. This page will refresh automatically.
          </p>
          {/* Cheap client-free polling: server-side refresh every 3s until paid. */}
          <meta httpEquiv="refresh" content="3" />
        </>
      ) : (
        <>
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600">
            <XCircle className="h-6 w-6 stroke-[2.5]" />
          </div>
          <h1 className="text-base font-extrabold text-slate-900">Payment not found</h1>
          <p className="mt-2 text-xs text-slate-500">No matching payment for this session.</p>
        </>
      )}

      <Link
        href="/billing"
        className="mt-6 inline-block rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
      >
        Back to Billing
      </Link>
    </div>
  );
}
