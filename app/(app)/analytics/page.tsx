import { TrendingUp } from 'lucide-react';
import ModulePlaceholder from '@/components/ModulePlaceholder';
import { requireRole } from '@/lib/auth';
import { loadLocationsForOrg } from '@/lib/active-location';

export const metadata = { title: 'Business Intelligence · Bookpitch' };

export default async function AnalyticsPage() {
  const session = await requireRole('owner');
  const { active } = await loadLocationsForOrg(session.organizationId);
  return (
    <ModulePlaceholder
      title="Business intelligence"
      incoming="P2.3"
      icon={TrendingUp}
      session={session}
      activeLocation={active}
    />
  );
}
