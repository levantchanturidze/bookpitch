import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { removeFromWaitlist } from '@/lib/waitlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DELETE /api/waitlist/:id — staff-visible.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'booking.update', { organizationId: ctx.activeOrganizationId! }, 'waitlist');
    const { id } = await params;
    await removeFromWaitlist(ctxToSession(ctx), id);
    return { ok: true };
  });
}
