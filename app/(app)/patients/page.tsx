import { requireRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { loadLocationsForOrg } from '@/lib/active-location';
import { toCustomerDetailDto } from '@/lib/customers';
import PatientList from '@/components/patients/PatientList';

export const metadata = { title: 'Patients · Bookpitch' };

// Server component: fetches everything the client list needs, decrypts sensitive
// fields, records ONE list audit entry, then hands off. Server Actions
// (createCustomerAction etc.) revalidate this path after mutations, so the
// list stays in sync without any client-side refetch.
export default async function PatientsPage() {
  const session = await requireRole('owner', 'practitioner', 'receptionist');
  const { active } = await loadLocationsForOrg(session.organizationId);

  const customers = await withOrg(session.organizationId, async (tx) => {
    const rows = await tx.customer.findMany({
      orderBy: { createdAt: 'desc' },
      include: { treatmentHistory: { orderBy: { createdAt: 'desc' } } },
    });
    await writeAudit(tx, session, 'list', 'customer', null, { count: rows.length });
    return rows.map(toCustomerDetailDto);
  });

  return <PatientList customers={customers} locationType={active.type} />;
}
