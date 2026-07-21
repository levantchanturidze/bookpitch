import { Calendar } from 'lucide-react';
import ModulePlaceholder from '@/components/ModulePlaceholder';
import { requireRole } from '@/lib/auth';
import { loadLocationsForOrg } from '@/lib/active-location';

export const metadata = { title: 'Scheduler · Bookpitch' };

export default async function SchedulerPage() {
  const session = await requireRole('owner', 'practitioner', 'receptionist');
  const { active } = await loadLocationsForOrg(session.organizationId);
  return (
    <ModulePlaceholder
      title="Scheduler"
      incoming="P1.5"
      icon={Calendar}
      session={session}
      activeLocation={active}
    />
  );
}
