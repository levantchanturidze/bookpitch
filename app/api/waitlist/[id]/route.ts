import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission, resolveWaitlistOwner } from '@/lib/rbac';
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
    const { id } = await params;
    // F-09 companion: resolve the row's owner (waitlist.staff.userId) so
    // :own-scoped roles (PROVIDER's booking.update:own) are checked against
    // the actual owner. Without this, can()'s list-mode fallback would
    // grant the delete for ANY waitlist row.
    const ownerUserId = await resolveWaitlistOwner(id, ctx.activeOrganizationId!);
    requirePermission(
      ctx, 'booking.update',
      { organizationId: ctx.activeOrganizationId!, ownerUserId: ownerUserId ?? undefined },
      'waitlist',
    );
    await removeFromWaitlist(ctxToSession(ctx), id);
    return { ok: true };
  });
}
