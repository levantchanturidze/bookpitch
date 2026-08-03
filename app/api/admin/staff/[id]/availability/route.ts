import type { NextRequest } from 'next/server';
import { InvalidInputError, ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { setAvailability, type AvailabilityWindow } from '@/lib/admin';
import { prismaAdmin } from '@/lib/db';

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
    const staff = await prismaAdmin.staff.findFirst({
      where: { id, organizationId: ctx.activeOrganizationId! },
      select: { userId: true },
    });
    const ownerUserId = staff?.userId ?? null;
    requirePermission(
      ctx, 'staff.schedule.manage',
      { organizationId: ctx.activeOrganizationId!, ownerUserId: ownerUserId ?? undefined },
      'admin',
    );
    const body = (await req.json().catch(() => ({}))) as { windows?: unknown };
    if (!Array.isArray(body.windows)) throw new InvalidInputError('windows must be an array');
    await setAvailability(ctxToSession(ctx), id, body.windows as AvailabilityWindow[]);
    return { ok: true };
  });
}
