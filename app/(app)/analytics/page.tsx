import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePagePermission } from '@/lib/rbac';
import { loadLocationsForCaller } from '@/lib/active-location';
import NoLocationAssigned from '@/components/shell/NoLocationAssigned';
import { computeMetrics, dailyRoster } from '@/lib/analytics';
import AnalyticsView from '@/components/analytics/AnalyticsView';
import { withOrg } from '@/lib/db';

export const metadata = { title: 'Business Intelligence · Bookpitch' };
export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const ctx = await requireAuthContext();
  requirePagePermission(
    ctx,
    'report.branch',
    { organizationId: ctx.activeOrganizationId! },
    'analytics',
  );
  const session = ctxToSession(ctx);
  const { active } = await loadLocationsForCaller(ctx);
  if (!active) return <NoLocationAssigned />;

  const [metrics, roster, org] = await Promise.all([
    computeMetrics(session, active.id),
    dailyRoster(session, active.id),
    withOrg(session.organizationId, (tx) =>
      tx.organization.findUniqueOrThrow({
        where: { id: session.organizationId },
        select: { currency: true },
      }),
    ),
  ]);

  return <AnalyticsView metrics={metrics} roster={roster} currency={org.currency} />;
}
