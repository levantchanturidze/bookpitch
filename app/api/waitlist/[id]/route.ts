import { NotFoundError, ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission, resolveWaitlistResource } from '@/lib/rbac';
import { removeFromWaitlist } from '@/lib/waitlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DELETE /api/waitlist/:id — staff-visible.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    const { id } = await params;
    // Resolve the row BEFORE authorising it — owner (via its staff member's
    // linked user) and branch (derived: location, else staff's, else
    // service's) together. This used to resolve the owner only, so a `:branch`
    // caller took list mode and could delete any waitlist row in the
    // organisation (scoped-RBAC audit §3.3, probe P7). A cross-tenant id and a
    // deleted one are indistinguishable here, which is the right answer.
    //
    // Coarse gate first: a caller holding no booking.update at all is refused
    // before the lookup, so "not found" is only ever said to someone who
    // could have acted on the row.
    requirePermission(
      ctx,
      'booking.update',
      { organizationId: ctx.activeOrganizationId! },
      'waitlist',
    );
    const resource = await resolveWaitlistResource(id, ctx.activeOrganizationId!);
    if (!resource) throw new NotFoundError('waitlist entry not found');
    requirePermission(ctx, 'booking.update', resource, 'waitlist');
    await removeFromWaitlist(ctxToSession(ctx), id);
    return { ok: true };
  });
}
