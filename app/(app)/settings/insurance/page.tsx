import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { listInsurers } from '@/lib/insurance';
import { withOrg } from '@/lib/db';
import { toCustomerDto } from '@/lib/customers';
import InsuranceView from './InsuranceView';

export const metadata = { title: 'Insurance · Bookpitch' };
export const dynamic = 'force-dynamic';

export default async function InsurancePage() {
  const ctx = await requireAuthContext();
  requirePermission(
    ctx,
    'service.manage',
    { organizationId: ctx.activeOrganizationId! },
    'insurance',
  );
  const session = ctxToSession(ctx);
  const [insurers, customers] = await Promise.all([
    listInsurers(session),
    withOrg(session.organizationId, (tx) =>
      tx.customer.findMany({ orderBy: { name: 'asc' } }).then((rows) =>
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          insurerName: r.insurerName ?? null,
          insurancePolicyNumber: r.insurancePolicyNumber ?? null,
        })),
      ),
    ),
  ]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-extrabold tracking-tight text-slate-900">
          Insurance claim exports
        </h1>
        <p className="mt-1 text-xs text-slate-500">
          Exports completed appointments with an ICD-10 code whose customer carries insurance. The
          CSV matches the standard 11-column shape Georgian insurers accept.
        </p>
      </div>
      <InsuranceView insurers={insurers} customers={customers} />
    </div>
  );
}
