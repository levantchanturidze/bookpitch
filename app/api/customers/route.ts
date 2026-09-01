import type { NextRequest } from 'next/server';
import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import {
  CUSTOMER_LIST_ORDER,
  CUSTOMER_LIST_SELECT,
  buildCreateData,
  buildCustomerListWhere,
  decodeCustomerCursor,
  encodeCustomerCursor,
  parseCreateInput,
  parsePageSize,
  toCustomerDto,
  toCustomerListItemDto,
} from '@/lib/customers';

// GET /api/customers?limit=&cursor=&q=
//
// F16-008: this used to be `findMany({ orderBy })` — every customer in the
// organization, unbounded, with allergies and clinical notes decrypted per row.
// It is now keyset-paginated and returns the list projection only. Search runs
// in the database across the whole organization, not over whatever the client
// happens to be holding.
//
// Response shape changed from `{ customers: CustomerDto[] }` to
// `{ customers: CustomerListItemDto[], nextCursor, hasMore }`. Consumers were
// inventoried first: at the time of the change this endpoint had none — the
// patients page queried Prisma directly. It now has exactly one, PatientList.
export async function GET(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'client.read:contact',
      { organizationId: ctx.activeOrganizationId! },
      'customers',
    );
    const session = ctxToSession(ctx);
    const url = new URL(req.url);

    const limit = parsePageSize(url.searchParams.get('limit'));
    const rawCursor = url.searchParams.get('cursor');
    const cursor = rawCursor ? decodeCustomerCursor(rawCursor) : null;
    const search = url.searchParams.get('q');

    const page = await withOrg(session.organizationId, async (tx) => {
      // take limit + 1: the extra row answers "is there another page" without
      // a second count query, and is dropped before serialising.
      const rows = await tx.customer.findMany({
        where: buildCustomerListWhere({
          organizationId: session.organizationId,
          search,
          cursor,
        }),
        select: CUSTOMER_LIST_SELECT,
        orderBy: CUSTOMER_LIST_ORDER,
        take: limit + 1,
      });

      const hasMore = rows.length > limit;
      const visible = hasMore ? rows.slice(0, limit) : rows;
      const last = visible[visible.length - 1];

      await writeAudit(tx, session, 'list', 'customer', null, {
        count: visible.length,
        paged: true,
        searched: !!(search ?? '').trim(),
      });

      return {
        items: visible.map((r) => toCustomerListItemDto(r, { ctx })),
        nextCursor: hasMore && last ? encodeCustomerCursor(last) : null,
        hasMore,
      };
    });

    return { customers: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  });
}

// POST /api/customers → create a new customer with consent captured.
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'client.create',
      { organizationId: ctx.activeOrganizationId! },
      'customers',
    );
    const session = ctxToSession(ctx);
    const input = parseCreateInput(await req.json().catch(() => null));

    const customer = await withOrg(session.organizationId, async (tx) => {
      const row = await tx.customer.create({
        data: buildCreateData(input, session.organizationId),
      });
      await writeAudit(tx, session, 'create', 'customer', row.id);
      return toCustomerDto(row, { ctx });
    });

    return { customer };
  });
}
