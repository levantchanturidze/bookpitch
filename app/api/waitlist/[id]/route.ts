import { requireRole, withApi } from '@/lib/auth';
import { removeFromWaitlist } from '@/lib/waitlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DELETE /api/waitlist/:id — staff-visible.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApi(async () => {
    const session = await requireRole('owner', 'practitioner', 'receptionist');
    const { id } = await params;
    await removeFromWaitlist(session, id);
    return { ok: true };
  });
}
