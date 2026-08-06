import { notFound } from 'next/navigation';
import { requireAuthContext, requirePermission, can, loadOrgToggles } from '@/lib/rbac';
import { getOrganization } from '@/lib/platform/orgs';
import OrgDetail from '@/components/platform/OrgDetail';

export const dynamic = 'force-dynamic';

export default async function PlatformOrgDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requireAuthContext();
  requirePermission(ctx, 'platform.analytics.read', undefined, 'platform');
  const { id } = await params;
  const org = await getOrganization(id);
  if (!org) return notFound();

  // Pre-compute which action buttons the caller can invoke so the client
  // component doesn't ship a broken form for a role that can't submit it.
  const capabilities = {
    canSuspend: can(ctx, 'platform.org.suspend'),
    canDelete: can(ctx, 'platform.org.delete'),
    canChangeOwner: can(ctx, 'platform.org.owner.change'),
    canResetPassword: can(ctx, 'platform.user.password_reset'),
    canImpersonate: can(ctx, 'platform.impersonate'),
    // F-08 edit-org: reuses platform.org.suspend (same tier — SUPER_ADMIN
    // + PLATFORM_ADMIN — and semantically similar: both mutate org state).
    canEdit: can(ctx, 'platform.org.suspend'),
    // F-08 feature-flags/toggles: SUPER_ADMIN only per spec §6.1
    // "Feature flags / global config". Others get view-only (rendered
    // in the panel).
    canEditToggles: can(ctx, 'platform.config.manage'),
  };

  const toggles = await loadOrgToggles(id);

  return (
    <OrgDetail
      org={{
        id: org.id,
        name: org.name,
        status: org.status,
        plan: org.plan,
        planStatus: org.planStatus,
        vertical: org.vertical,
        allowSupportImpersonation: org.allowSupportImpersonation,
        stripeCustomerId: org.stripeCustomerId,
        stripeSubscriptionId: org.stripeSubscriptionId,
        currentPeriodEnd: org.currentPeriodEnd?.toISOString() ?? null,
        owner: org.ownerUser
          ? { id: org.ownerUser.id, email: org.ownerUser.email, fullName: org.ownerUser.fullName }
          : null,
        counts: org._count,
        members: org.memberships.map((m) => ({
          id: m.id,
          userId: m.user.id,
          email: m.user.email,
          fullName: m.user.fullName,
          roleKey: m.roleRef?.key ?? m.role,
        })),
      }}
      capabilities={capabilities}
      toggles={toggles}
    />
  );
}
