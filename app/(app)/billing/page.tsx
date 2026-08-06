import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { loadLocationsForOrg } from '@/lib/active-location';
import BillingList, { type BillingRow } from '@/components/billing/BillingList';

export const metadata = { title: 'Billing · Bookpitch' };
export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  const ctx = await requireAuthContext();
  requirePermission(
    ctx,
    'payment.charge',
    { organizationId: ctx.activeOrganizationId! },
    'billing',
  );
  const session = ctxToSession(ctx);
  const { active } = await loadLocationsForOrg(session.organizationId);

  const rows: BillingRow[] = await withOrg(session.organizationId, async (tx) => {
    // Show current + last-30d appointments at the active location, plus their
    // most recent payment (for method display on paid rows).
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 30);
    const appts = await tx.appointment.findMany({
      where: {
        locationId: active.id,
        status: { not: 'cancelled' },
        startsAt: { gte: since },
      },
      include: {
        customer: { select: { name: true } },
        staff: { select: { name: true } },
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { method: true, status: true },
        },
      },
      orderBy: [{ paymentStatus: 'asc' }, { startsAt: 'asc' }],
    });
    return appts.map((a) => ({
      id: a.id,
      date: a.startsAt.toISOString().slice(0, 10),
      time: a.startsAt.toISOString().slice(11, 16),
      customerName: a.customer.name,
      serviceName: a.serviceName,
      staffName: a.staff.name,
      price: Number(a.price),
      status: a.status,
      paymentStatus: a.paymentStatus,
      lastPaymentMethod: a.payments[0]?.method ?? null,
    }));
  });

  return <BillingList location={{ name: active.name, type: active.type }} rows={rows} />;
}
