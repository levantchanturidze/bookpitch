import { ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePagePermission } from '@/lib/rbac';
import { listMembers } from '@/lib/admin';
import MembersPanel from '@/components/settings/MembersPanel';

export const dynamic = 'force-dynamic';

export default async function SettingsMembersPage() {
  const ctx = await requireAuthContext();
  requirePagePermission(
    ctx,
    'staff.invite',
    { organizationId: ctx.activeOrganizationId! },
    'admin',
  );
  const session = ctxToSession(ctx);
  const members = await listMembers(session);
  return <MembersPanel members={members} currentUserId={session.userId} />;
}
