import { MessageSquare } from 'lucide-react';
import ModulePlaceholder from '@/components/ModulePlaceholder';
import { requireRole } from '@/lib/auth';
import { loadLocationsForOrg } from '@/lib/active-location';

export const metadata = { title: 'Reminders · Bookpitch' };

export default async function RemindersPage() {
  const session = await requireRole('owner', 'receptionist');
  const { active } = await loadLocationsForOrg(session.organizationId);
  return (
    <ModulePlaceholder
      title="Reminders"
      incoming="P2.2"
      icon={MessageSquare}
      session={session}
      activeLocation={active}
    />
  );
}
