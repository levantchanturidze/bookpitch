import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePagePermission } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { recentDsrActivity, dsrDeadlineDays } from '@/lib/gdpr-queue';
import PrivacyView from './PrivacyView';

export const metadata = { title: 'Privacy · Bookpitch' };
export const dynamic = 'force-dynamic';

// Two responsibilities:
// - Show recent Data Subject Request (DSR) activity with an SLA clock
//   against DSR_DEADLINE_DAYS.
// - Provide an inline customer picker to trigger export / anonymize on
//   demand (endpoints already exist under /api/customers/[id]/*).
export default async function PrivacyPage() {
  const ctx = await requireAuthContext();
  requirePagePermission(
    ctx,
    'org.settings.update:org',
    { organizationId: ctx.activeOrganizationId! },
    'settings',
  );
  const session = ctxToSession(ctx);
  const dsrRows = await withOrg(session.organizationId, (tx) => recentDsrActivity(tx, {}));
  const customers = await withOrg(session.organizationId, (tx) =>
    tx.customer.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
  );
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-extrabold tracking-tight text-slate-900">Privacy</h1>
        <p className="mt-1 text-xs text-slate-500">
          Handle Data Subject Requests (export + delete). Every action here is audit-logged
          automatically. GDPR deadline: {dsrDeadlineDays()} days.
        </p>
      </div>
      <PrivacyView rows={dsrRows} customers={customers} />
    </div>
  );
}
