import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { listInsurers } from '@/lib/insurance';
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
  const insurers = await listInsurers(ctxToSession(ctx));
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
      <InsuranceView insurers={insurers} />
    </div>
  );
}
