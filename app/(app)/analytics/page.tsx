import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { loadLocationsForOrg } from '@/lib/active-location';
import { computeMetrics, dailyRoster } from '@/lib/analytics';
import AnalyticsView from '@/components/analytics/AnalyticsView';
import { withOrg } from '@/lib/db';

export const metadata = { title: 'Business Intelligence · Bookpitch' };
export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const ctx = await requireAuthContext();
  requirePermission(
    ctx,
    'report.branch',
    { organizationId: ctx.activeOrganizationId! },
    'analytics',
  );
  const session = ctxToSession(ctx);
  const { active } = await loadLocationsForOrg(session.organizationId);

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
