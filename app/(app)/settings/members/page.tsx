import { ctxToSession } from '@/lib/auth';
import { can, requireAuthContext, requirePagePermission } from '@/lib/rbac';
import { listMembers } from '@/lib/admin';
import { listBranchScopedRoleKeys, listBranches } from '@/lib/admin/scoped-access';
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
  const [members, branches, branchScopedRoleKeys] = await Promise.all([
    listMembers(session),
    listBranches(session),
    listBranchScopedRoleKeys(session),
  ]);
  // Changing a member's branches changes what they can reach — the same
  // authority as changing their role. The action enforces it; this only decides
  // whether the control is offered.
  const canAssignBranches = can(ctx, 'staff.role.assign', {
    organizationId: ctx.activeOrganizationId!,
  });
  return (
    <MembersPanel
      members={members}
      currentUserId={session.userId}
      branches={branches}
      branchScopedRoleKeys={branchScopedRoleKeys}
      canAssignBranches={canAssignBranches}
    />
  );
}
