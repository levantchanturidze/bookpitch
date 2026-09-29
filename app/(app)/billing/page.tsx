import { ctxToSession } from '@/lib/auth';
import {
  requireAuthContext,
  requirePagePermission,
  scopedByOwn,
  scopedLocationIds,
} from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { loadLocationsForOrg } from '@/lib/active-location';
import BillingList, { type BillingRow } from '@/components/billing/BillingList';

export const metadata = { title: 'Billing · Bookpitch' };
export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  const ctx = await requireAuthContext();
  requirePagePermission(
    ctx,
    'payment.charge',
    { organizationId: ctx.activeOrganizationId! },
    'billing',
  );
  const session = ctxToSession(ctx);
  const [{ active }, org] = await Promise.all([
    loadLocationsForOrg(session.organizationId),
    withOrg(session.organizationId, (tx) =>
      tx.organization.findUniqueOrThrow({
        where: { id: session.organizationId },
        select: { currency: true },
      }),
    ),
  ]);

  // The list below is booking data, so its visibility follows booking.read —
  // payment.charge is scope-less and decides only whether the page opens. This
  // used to list any active location to any member who can take a payment
  // (scoped-RBAC audit §3.5). `[]` (no branches) puts no location in scope.
  const scoped = await scopedLocationIds(ctx, 'booking.read');
  const ownUserId = scopedByOwn(ctx, 'booking.read');
  const locationInScope = scoped === null || scoped.includes(active.id);

  const rows: BillingRow[] = await withOrg(session.organizationId, async (tx) => {
    if (!locationInScope) return [];
    // Show current + last-30d appointments at the active location, plus their
    // most recent payment (for method display on paid rows).
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 30);
    const appts = await tx.appointment.findMany({
      where: {
        locationId: active.id,
        ...(ownUserId ? { staff: { userId: ownUserId } } : {}),
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

  return (
    <BillingList
      location={{ name: active.name, type: active.type, currency: org.currency }}
      rows={rows}
    />
  );
}
