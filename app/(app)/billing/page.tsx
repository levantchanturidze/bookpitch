import { DollarSign } from 'lucide-react';
import ModulePlaceholder from '@/components/ModulePlaceholder';
import { requireRole } from '@/lib/auth';
import { loadLocationsForOrg } from '@/lib/active-location';

export const metadata = { title: 'Billing · Bookpitch' };

export default async function BillingPage() {
  const session = await requireRole('owner', 'receptionist');
  const { active } = await loadLocationsForOrg(session.organizationId);
  return (
    <ModulePlaceholder
      title="Billing & POS"
      incoming="P2.1"
      icon={DollarSign}
      session={session}
      activeLocation={active}
    />
  );
}
