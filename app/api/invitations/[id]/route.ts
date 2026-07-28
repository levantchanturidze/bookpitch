import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { revokeInvitation } from '@/lib/invitations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DELETE /api/invitations/:id — sets status='revoked' (audit trail stays
// intact; token immediately unusable via the pending check).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'staff.invite', { organizationId: ctx.activeOrganizationId! }, 'invitations');
    const { id } = await params;
    await revokeInvitation(ctxToSession(ctx), id);
    return { ok: true };
  });
}
