import { requireRole } from '@/lib/auth';
import { loadLocationsForOrg } from '@/lib/active-location';
import { computeMetrics, dailyRoster } from '@/lib/analytics';
import AnalyticsView from '@/components/analytics/AnalyticsView';

export const metadata = { title: 'Business Intelligence · Bookpitch' };
export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const session = await requireRole('owner');
  const { active } = await loadLocationsForOrg(session.organizationId);

  const [metrics, roster] = await Promise.all([
    computeMetrics(session, active.id),
    dailyRoster(session, active.id),
  ]);

  return <AnalyticsView metrics={metrics} roster={roster} />;
}
