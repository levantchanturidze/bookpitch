import type { NextRequest } from 'next/server';
import { InvalidInputError, NotFoundError, ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission, resolveStaffResource } from '@/lib/rbac';
import { setAvailability, type AvailabilityWindow } from '@/lib/admin';

// PUT /api/admin/staff/[id]/availability
// Body: { windows: Array<{ weekday, startTime, endTime }> } — replaces all
// availability windows for the staff atomically.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const { id } = await params;
    // Resolve the staff row BEFORE authorising it — its linked user for `:own`
    // (PROVIDER's staff.schedule.manage:own; an unlinked row resolves to null
    // and is refused, U-05) and its location's branch for `:branch`
    // (SENIOR_PROVIDER, BRANCH_MANAGER). The resolver reads through withOrg
    // (SEC-007), and setAvailabilityAction authorises through the same one
    // (U-06), so this route and the action cannot disagree again. The coarse
    // gate first means a caller with no grant at all learns nothing from 404.
    requirePermission(
      ctx,
      'staff.schedule.manage',
      { organizationId: ctx.activeOrganizationId! },
      'admin',
    );
    const resource = await resolveStaffResource(id, ctx.activeOrganizationId!);
    if (!resource) throw new NotFoundError('staff not found');
    requirePermission(ctx, 'staff.schedule.manage', resource, 'admin');
    const body = (await req.json().catch(() => ({}))) as { windows?: unknown };
    if (!Array.isArray(body.windows)) throw new InvalidInputError('windows must be an array');
    await setAvailability(ctxToSession(ctx), id, body.windows as AvailabilityWindow[]);
    return { ok: true };
  });
}
