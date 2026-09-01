import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePagePermission } from '@/lib/rbac';
import { getBilling } from '@/lib/billing/service';
import BillingView from './BillingView';

export const metadata = { title: 'Billing · Bookpitch' };
export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  const ctx = await requireAuthContext();
  requirePagePermission(
    ctx,
    'org.billing.read',
    { organizationId: ctx.activeOrganizationId! },
    'billing',
  );
  const session = ctxToSession(ctx);
  const { org, effective, plans } = await getBilling(session);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-extrabold tracking-tight text-slate-900">Billing</h1>
        <p className="mt-1 text-xs text-slate-500">
          You are on the <strong>{effective.name}</strong> plan.{' '}
          {org.currentPeriodEnd && (
            <span>Current period ends {org.currentPeriodEnd.toISOString().slice(0, 10)}.</span>
          )}
        </p>
      </div>
      <BillingView
        plans={Object.values(plans)}
        currentPlanId={effective.id}
        planStatus={org.planStatus}
      />
    </div>
  );
}
