import type { NextRequest } from 'next/server';
import { ctxToSession, withApi, InvalidInputError } from '@/lib/auth';
import { requireAuthContext, requirePermission, scopedLocationIds, scopedByOwn } from '@/lib/rbac';
import { addToWaitlist, listWaitlist } from '@/lib/waitlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/waitlist — staff-visible.
export async function GET() {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'booking.read',
      { organizationId: ctx.activeOrganizationId! },
      'waitlist',
    );
    // Phase 6: branch scoping — BRANCH_MANAGER only sees rows in their
    // assigned branches (plus flexible/no-location rows).
    const scoped = await scopedLocationIds(ctx);
    const ownUserId = scopedByOwn(ctx, 'booking.read');
    const rows = await listWaitlist(ctxToSession(ctx), {
      scopedLocationIds: scoped,
      ownUserId,
    });
    return { waitlist: rows };
  });
}

// POST /api/waitlist { customerId, staffId?, serviceId?, locationId?,
//                     preferredFrom, preferredTo, notes? }
export async function POST(req: NextRequest) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(
      ctx,
      'booking.create',
      { organizationId: ctx.activeOrganizationId! },
      'waitlist',
    );
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new InvalidInputError('invalid body');
    const iso = (k: string) => (typeof body[k] === 'string' ? new Date(String(body[k])) : null);
    const preferredFrom = iso('preferredFrom');
    const preferredTo = iso('preferredTo');
    if (!preferredFrom || !preferredTo) throw new InvalidInputError('window is required');
    return addToWaitlist(ctxToSession(ctx), {
      customerId: String(body.customerId ?? ''),
      locationId: body.locationId ? String(body.locationId) : undefined,
      staffId: body.staffId ? String(body.staffId) : undefined,
      serviceId: body.serviceId ? String(body.serviceId) : undefined,
      preferredFrom,
      preferredTo,
      notes: body.notes ? String(body.notes) : undefined,
    });
  });
}
