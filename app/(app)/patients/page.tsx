import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePagePermission, can } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { loadLocationsForOrg } from '@/lib/active-location';
import {
  CUSTOMER_LIST_ORDER,
  CUSTOMER_LIST_SELECT,
  CUSTOMER_PAGE_DEFAULT,
  buildCustomerListWhere,
  encodeCustomerCursor,
  toCustomerListItemDto,
} from '@/lib/customers';
import PatientList from '@/components/patients/PatientList';

export const metadata = { title: 'Patients · Bookpitch' };

// Server component: renders the FIRST PAGE of the list and hands off.
//
// F16-008: this used to load every customer in the organization together with
// every treatment-history row for each of them, then decrypt allergies and
// clinical notes per row — to render a list of names and phone numbers. The
// list is now one bounded page of the list projection; detail and history are
// fetched per selection from GET /api/customers/[id].
export default async function PatientsPage() {
  const ctx = await requireAuthContext();
  requirePagePermission(
    ctx,
    'client.read:contact',
    { organizationId: ctx.activeOrganizationId! },
    'customers',
  );
  const session = ctxToSession(ctx);
  const { active } = await loadLocationsForOrg(session.organizationId);
  // UI-branching: only callers who can export get the GDPR export button.
  // Phase 0 §8.2 called out the old `session.role === 'owner'` check here.
  const canExport = can(ctx, 'client.export', { organizationId: ctx.activeOrganizationId! });

  const page = await withOrg(session.organizationId, async (tx) => {
    const rows = await tx.customer.findMany({
      where: buildCustomerListWhere({ organizationId: session.organizationId }),
      select: CUSTOMER_LIST_SELECT,
      orderBy: CUSTOMER_LIST_ORDER,
      take: CUSTOMER_PAGE_DEFAULT + 1,
    });
    const hasMore = rows.length > CUSTOMER_PAGE_DEFAULT;
    const visible = hasMore ? rows.slice(0, CUSTOMER_PAGE_DEFAULT) : rows;
    const last = visible[visible.length - 1];
    await writeAudit(tx, session, 'list', 'customer', null, {
      count: visible.length,
      paged: true,
    });
    return {
      items: visible.map((r) => toCustomerListItemDto(r, { ctx })),
      nextCursor: hasMore && last ? encodeCustomerCursor(last) : null,
      hasMore,
    };
  });

  return (
    <PatientList
      initialCustomers={page.items}
      initialCursor={page.nextCursor}
      initialHasMore={page.hasMore}
      locationType={active.type}
      isOwner={canExport}
    />
  );
}
