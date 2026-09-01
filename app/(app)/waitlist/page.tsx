import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePagePermission } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { listWaitlist } from '@/lib/waitlist';
import WaitlistView from './WaitlistView';

export const metadata = { title: 'Waitlist · Bookpitch' };
export const dynamic = 'force-dynamic';

export default async function WaitlistPage() {
  const ctx = await requireAuthContext();
  requirePagePermission(
    ctx,
    'booking.read',
    { organizationId: ctx.activeOrganizationId! },
    'waitlist',
  );
  const session = ctxToSession(ctx);
  const [rows, customers, staff, services] = await Promise.all([
    listWaitlist(session),
    withOrg(session.organizationId, (tx) =>
      tx.customer.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 500,
      }),
    ),
    withOrg(session.organizationId, (tx) =>
      tx.staff.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ),
    withOrg(session.organizationId, (tx) =>
      tx.service.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ),
  ]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-extrabold tracking-tight text-slate-900">Waitlist</h1>
        <p className="mt-1 text-xs text-slate-500">
          When an appointment cancels, matching entries here get a notification. Waitlist customers
          are not messaged directly — you follow up via your usual channel.
        </p>
      </div>
      <WaitlistView
        rows={rows.map((r) => ({
          id: r.id,
          customerId: r.customerId,
          staffId: r.staffId,
          serviceId: r.serviceId,
          preferredFrom: r.preferredFrom.toISOString(),
          preferredTo: r.preferredTo.toISOString(),
          status: r.status,
          notes: r.notes,
          createdAt: r.createdAt.toISOString(),
        }))}
        customers={customers}
        staff={staff}
        services={services}
      />
    </div>
  );
}
