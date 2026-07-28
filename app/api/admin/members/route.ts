import { ctxToSession, withApi } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { listMembers } from '@/lib/admin';

// GET /api/admin/members — list org staff (name + role).
//
// The old POST handler (invite-with-password) was removed in Phase 4
// alongside `lib/admin.ts::inviteMember` — see Phase 0 R4. New invitations
// go through the token-based flow: POST /api/invitations.
export async function GET() {
  return withApi(async () => {
    const ctx = await requireAuthContext();
    requirePermission(ctx, 'staff.invite', { organizationId: ctx.activeOrganizationId! }, 'admin');
    return { members: await listMembers(ctxToSession(ctx)) };
  });
}
