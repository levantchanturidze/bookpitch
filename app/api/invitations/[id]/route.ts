import { requireRole, withApi } from '@/lib/auth';
import { revokeInvitation } from '@/lib/invitations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DELETE /api/invitations/:id — owner only. Sets status='revoked' (audit
// trail stays intact; token immediately unusable via the pending check).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApi(async () => {
    const session = await requireRole('owner');
    const { id } = await params;
    await revokeInvitation(session, id);
    return { ok: true };
  });
}
