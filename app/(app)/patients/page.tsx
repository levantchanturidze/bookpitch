import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission, can } from '@/lib/rbac';
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
  const ctx = await requireAuthContext();
  requirePermission(ctx, 'client.read:contact', { organizationId: ctx.activeOrganizationId! }, 'customers');
  const session = ctxToSession(ctx);
  const { active } = await loadLocationsForOrg(session.organizationId);
  // UI-branching: only callers who can export get the GDPR export button.
  // Phase 0 §8.2 called out the old `session.role === 'owner'` check here.
  const canExport = can(ctx, 'client.export', { organizationId: ctx.activeOrganizationId! });

  const customers = await withOrg(session.organizationId, async (tx) => {
    const rows = await tx.customer.findMany({
      orderBy: { createdAt: 'desc' },
      include: { treatmentHistory: { orderBy: { createdAt: 'desc' } } },
    });
    await writeAudit(tx, session, 'list', 'customer', null, { count: rows.length });
    return rows.map((r) => toCustomerDetailDto(r, { ctx }));
  });

  return (
    <PatientList
      customers={customers}
      locationType={active.type}
      isOwner={canExport}
    />
  );
}
