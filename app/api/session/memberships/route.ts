import { requireSession, withApi } from '@/lib/auth';
import { listUserMemberships } from '@/lib/org-switch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/session/memberships → all orgs the caller belongs to.
export async function GET() {
  return withApi(async () => {
    const session = await requireSession();
    const memberships = await listUserMemberships(session.userId);
    return { memberships, activeOrganizationId: session.organizationId };
  });
}
