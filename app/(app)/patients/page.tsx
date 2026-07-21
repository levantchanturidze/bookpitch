import { Users } from 'lucide-react';
import ModulePlaceholder from '@/components/ModulePlaceholder';
import { requireRole } from '@/lib/auth';
import { loadLocationsForOrg } from '@/lib/active-location';

export const metadata = { title: 'Patients · Bookpitch' };

export default async function PatientsPage() {
  const session = await requireRole('owner', 'practitioner', 'receptionist');
  const { active } = await loadLocationsForOrg(session.organizationId);
  return (
    <ModulePlaceholder
      title={active.type === 'clinic' ? 'Patients' : 'Clients'}
      incoming="P1.4"
      icon={Users}
      session={session}
      activeLocation={active}
    />
  );
}
