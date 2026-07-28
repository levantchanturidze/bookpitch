import type { NextRequest } from 'next/server';
import { InvalidInputError, ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { setAvailability, type AvailabilityWindow } from '@/lib/admin';

// PUT /api/admin/staff/[id]/availability
// Body: { windows: Array<{ weekday, startTime, endTime }> } — replaces all
// availability windows for the staff atomically.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'staff.schedule.manage', { organizationId: ctx.activeOrganizationId! }, 'admin');
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { windows?: unknown };
    if (!Array.isArray(body.windows)) throw new InvalidInputError('windows must be an array');
    await setAvailability(ctxToSession(ctx), id, body.windows as AvailabilityWindow[]);
    return { ok: true };
  });
}
