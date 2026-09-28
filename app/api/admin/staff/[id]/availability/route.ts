import type { NextRequest } from 'next/server';
import { InvalidInputError, ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission, resolveStaffOwner } from '@/lib/rbac';
import { setAvailability, type AvailabilityWindow } from '@/lib/admin';

// PUT /api/admin/staff/[id]/availability
// Body: { windows: Array<{ weekday, startTime, endTime }> } — replaces all
// availability windows for the staff atomically.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const { id } = await params;
    // F-09 companion: resolve the staff row's linked user so :own-scoped
    // roles (PROVIDER's staff.schedule.manage:own) can edit their own
    // schedule but not others'. Staff without a linked user (contractor
    // records) resolve to null → :own-only callers denied by can().
    //
    // SEC-007: the resolver reads through withOrg, so RLS is the belt to the
    // WHERE clause's suspenders. U-06: setAvailabilityAction now uses the same
    // resolver, so this route and the action cannot disagree again.
    const ownerUserId = await resolveStaffOwner(id, ctx.activeOrganizationId!);
    requirePermission(
      ctx,
      'staff.schedule.manage',
      // U-05: pass null through, so the ":own-only callers denied" behaviour the
      // comment above promises is what actually happens.
      { organizationId: ctx.activeOrganizationId!, ownerUserId },
      'admin',
    );
    const body = (await req.json().catch(() => ({}))) as { windows?: unknown };
    if (!Array.isArray(body.windows)) throw new InvalidInputError('windows must be an array');
    await setAvailability(ctxToSession(ctx), id, body.windows as AvailabilityWindow[]);
    return { ok: true };
  });
}
