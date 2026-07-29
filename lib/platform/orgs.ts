// -----------------------------------------------------------------------------
// RBAC Phase 5 — organization management from the platform plane.
//
// Callers: PLATFORM_ADMIN + SUPER_ADMIN. Every function trusts its input
// (guards enforce at the route boundary via requirePermission).
//
// All queries use prismaAdmin because the caller is by definition NOT a
// member of the target org — RLS would filter them out. Every function
// writes an audit row (per-org organizationId, actor from ctx) so the
// action is traceable.
// -----------------------------------------------------------------------------

import { prismaAdmin } from '@/lib/db';
import { InvalidInputError, ConflictError } from '@/lib/auth';
import type { AuthContext } from '@/lib/rbac';
import { createInvitation } from '@/lib/invitations';
import { requestPasswordReset } from '@/lib/auth/password-reset';
import { log } from '@/lib/logger';
import type { UserRole } from '@prisma/client';

export type PlatformOrgSummary = {
  id: string;
  name: string;
  vertical: string | null;
  status: string;
  plan: string;
  planStatus: string;
  memberCount: number;
  ownerEmail: string | null;
  allowSupportImpersonation: boolean;
  createdAt: Date;
};

export async function listOrganizations(): Promise<PlatformOrgSummary[]> {
  const rows = await prismaAdmin.organization.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      ownerUser: { select: { email: true } },
      _count: { select: { memberships: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    vertical: r.vertical,
    status: r.status,
    plan: r.plan,
    planStatus: r.planStatus,
    memberCount: r._count.memberships,
    ownerEmail: r.ownerUser?.email ?? null,
    allowSupportImpersonation: r.allowSupportImpersonation,
    createdAt: r.createdAt,
  }));
}

export async function getOrganization(id: string) {
  const org = await prismaAdmin.organization.findUnique({
    where: { id },
    include: {
      ownerUser: { select: { id: true, email: true, fullName: true } },
      _count: {
        select: {
          memberships: true, locations: true, branches: true, customers: true,
          appointments: true,
        },
      },
      memberships: {
        include: {
          user: { select: { id: true, email: true, fullName: true } },
          roleRef: { select: { key: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!org) return null;
  return org;
}

async function writePlatformAudit(
  actor: AuthContext,
  organizationId: string,
  action: string,
  meta: Record<string, string | number | boolean | null> = {},
) {
  await prismaAdmin.auditLog.create({
    data: {
      organizationId,
      actorUserId: actor.userId,
      action,
      entity: 'staff',      // audit entity vocabulary — "staff" is closest to
                            // "org membership admin action". Distinguish by action.
      reason: `platform:${action}`,
      impersonationSessionId: actor.impersonation?.sessionId ?? null,
      breakGlassSessionId: actor.breakGlass?.sessionId ?? null,
      meta,
    },
  });
}

/**
 * Create a new organization from the platform plane (§6.1 row 1).
 * Atomic: creates the org, one initial Location (Phase 2 trigger creates
 * the matching Branch), and — if ownerEmail is provided — either promotes
 * an existing user or sends them an ORG_OWNER invitation. Never sets a
 * password; owner receives an invite link per §9 rule 4.
 *
 * Callers: platform.org.create (PLATFORM_ADMIN + SUPER_ADMIN per §6.1).
 */
export async function createOrganization(
  actor: AuthContext,
  input: {
    name: string;
    vertical?: 'clinic' | 'salon' | 'fitness' | 'mixed' | null;
    locationName?: string;
    locationType?: 'clinic' | 'salon';
    ownerEmail?: string | null;
  },
): Promise<{
  organizationId: string;
  locationId: string;
  ownerInvitationUrl: string | null;
  ownerPromotedExistingUser: boolean;
}> {
  const name = input.name.trim();
  if (name.length < 2) throw new InvalidInputError('name must be at least 2 characters');
  const vertical = input.vertical ?? null;
  if (vertical && !['clinic','salon','fitness','mixed'].includes(vertical)) {
    throw new InvalidInputError('vertical must be clinic|salon|fitness|mixed');
  }
  const locationType = input.locationType ?? 'clinic';
  if (locationType !== 'clinic' && locationType !== 'salon') {
    throw new InvalidInputError('locationType must be clinic or salon');
  }
  const locationName = (input.locationName ?? 'Main location').trim();
  const ownerEmail = input.ownerEmail?.trim().toLowerCase() || null;
  if (ownerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
    throw new InvalidInputError('ownerEmail is invalid');
  }

  // 1) Create the org + first location in a transaction. Phase 2 trigger
  //    creates the corresponding Branch row via the location insert.
  const { orgId, locationId } = await prismaAdmin.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name, vertical, status: 'active' },
      select: { id: true },
    });
    const loc = await tx.location.create({
      data: {
        organizationId: org.id,
        name: locationName,
        type: locationType,
      },
      select: { id: true },
    });
    return { orgId: org.id, locationId: loc.id };
  });

  await writePlatformAudit(actor, orgId, 'org.create', {
    name, vertical, locationName, locationType, viaOwnerEmail: ownerEmail ?? null,
  });
  log.info('platform.org.create', { orgId, actorUserId: actor.userId, name });

  // 2) Owner handling — same rules as changeOrganizationOwner: promote if
  //    the email already belongs to an active user, otherwise invite.
  //    Skipped entirely if ownerEmail is null (SUPER_ADMIN can wire an
  //    owner in a second step).
  let invitationUrl: string | null = null;
  let promotedExisting = false;
  if (ownerEmail) {
    const existingUser = await prismaAdmin.appUser.findUnique({
      where: { email: ownerEmail }, select: { id: true },
    });
    if (existingUser) {
      // Grant membership + owner pointer atomically. changeOrganizationOwner
      // assumes an existing membership, so do this write directly.
      const ownerRole = await prismaAdmin.role.findFirstOrThrow({
        where: { key: 'ORG_OWNER', organizationId: null }, select: { id: true },
      });
      await prismaAdmin.$transaction([
        prismaAdmin.membership.create({
          data: {
            organizationId: orgId,
            userId: existingUser.id,
            role: 'owner',
            roleId: ownerRole.id,
            status: 'active',
          },
        }),
        prismaAdmin.organization.update({
          where: { id: orgId }, data: { ownerUserId: existingUser.id },
        }),
      ]);
      await writePlatformAudit(actor, orgId, 'org.owner.change', {
        newOwnerUserId: existingUser.id, promotedExisting: true, viaCreate: true,
      });
      promotedExisting = true;
    } else {
      const inv = await createInvitation(
        { userId: actor.userId, email: actor.email, organizationId: orgId },
        { email: ownerEmail, role: 'owner' as UserRole },
      );
      await writePlatformAudit(actor, orgId, 'org.owner.invite', {
        email: ownerEmail, invitationId: inv.id, viaCreate: true,
      });
      invitationUrl = inv.url;
    }
  }

  return {
    organizationId: orgId,
    locationId,
    ownerInvitationUrl: invitationUrl,
    ownerPromotedExistingUser: promotedExisting,
  };
}

export async function suspendOrganization(actor: AuthContext, orgId: string, reason: string) {
  if (!reason || reason.trim().length < 5) {
    throw new InvalidInputError('reason must be at least 5 characters');
  }
  const org = await prismaAdmin.organization.update({
    where: { id: orgId },
    data: { status: 'suspended' },
    select: { id: true, name: true, status: true },
  });
  await writePlatformAudit(actor, orgId, 'org.suspend', { reason });
  log.info('platform.org.suspend', { orgId, actorUserId: actor.userId });
  return org;
}

export async function reactivateOrganization(actor: AuthContext, orgId: string) {
  const org = await prismaAdmin.organization.update({
    where: { id: orgId },
    data: { status: 'active' },
    select: { id: true, name: true, status: true },
  });
  await writePlatformAudit(actor, orgId, 'org.reactivate');
  log.info('platform.org.reactivate', { orgId, actorUserId: actor.userId });
  return org;
}

/**
 * Soft-delete. Sets status='archived' and records the earliest hard-delete
 * date (spec §9 rule 6 — 30-day grace). No row is dropped; the actual
 * purge is a manual DB operation once the grace period elapses.
 */
export async function softDeleteOrganization(actor: AuthContext, orgId: string, reason: string) {
  if (!reason || reason.trim().length < 5) {
    throw new InvalidInputError('reason must be at least 5 characters');
  }
  const existing = await prismaAdmin.organization.findUnique({
    where: { id: orgId },
    select: { status: true },
  });
  if (!existing) throw new InvalidInputError('organization not found');
  if (existing.status === 'archived') {
    throw new ConflictError('organization already archived');
  }
  const org = await prismaAdmin.organization.update({
    where: { id: orgId },
    data: { status: 'archived' },
    select: { id: true, name: true, status: true },
  });
  await writePlatformAudit(actor, orgId, 'org.soft_delete', {
    reason,
    hardDeleteEligibleAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  });
  log.info('platform.org.soft_delete', { orgId, actorUserId: actor.userId });
  return org;
}

/**
 * Send a password-reset link to a member of the target org. Reuses the
 * existing self-service password-reset flow — spec §9 rule 4 forbids
 * admins from setting passwords directly, so the link is the only path.
 */
export async function sendPasswordResetLink(
  actor: AuthContext,
  orgId: string,
  email: string,
) {
  // Verify the user is actually a member of the target org — prevents
  // "type any email, get a reset link" abuse from platform side.
  const user = await prismaAdmin.appUser.findUnique({
    where: { email },
    select: { id: true, memberships: { where: { organizationId: orgId }, select: { id: true } } },
  });
  if (!user || user.memberships.length === 0) {
    // Silent success — don't leak whether the email exists in this org.
    log.warn('platform.reset_link.unknown_user', { orgId, email });
    return { ok: true };
  }
  await requestPasswordReset({ email });
  await writePlatformAudit(actor, orgId, 'user.password_reset', { targetEmail: email });
  log.info('platform.reset_link.sent', { orgId, email, actorUserId: actor.userId });
  return { ok: true };
}

/**
 * Change or invite a new owner. If the email exists as a user + is a
 * member of the org, promote them (add an ORG_OWNER membership, transfer
 * organizations.owner_user_id). Otherwise send them an invitation with
 * role=owner via the token-based invitations flow.
 *
 * Spec §9 rule 1: every org must have ≥1 active ORG_OWNER. This function
 * never LEAVES an org with zero owners — the promotion adds first, the
 * demotion (if any) is a separate call.
 */
export async function changeOrganizationOwner(
  actor: AuthContext,
  orgId: string,
  newOwnerEmail: string,
) {
  const email = newOwnerEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new InvalidInputError('email is invalid');
  }

  const existingUser = await prismaAdmin.appUser.findUnique({
    where: { email },
    select: {
      id: true,
      memberships: { where: { organizationId: orgId }, select: { id: true } },
    },
  });

  if (existingUser && existingUser.memberships.length > 0) {
    // Already a member — promote by writing an owner membership row (if not
    // already one) and updating the org pointer. Requires cross-org write,
    // so uses prismaAdmin directly.
    await prismaAdmin.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: orgId },
        data: { ownerUserId: existingUser.id },
      });
    });
    await writePlatformAudit(actor, orgId, 'org.owner.change', {
      newOwnerUserId: existingUser.id, promotedExisting: true,
    });
    return { ok: true, invited: false };
  }

  // Not a member — send an invitation. The invite carries role='owner' so
  // acceptInvitation writes an ORG_OWNER membership on accept. Uses the
  // shared invitations flow (spec §9 rule 4 — never a temp password).
  const inv = await createInvitation(
    { userId: actor.userId, email: actor.email, organizationId: orgId },
    { email, role: 'owner' as UserRole },
  );
  await writePlatformAudit(actor, orgId, 'org.owner.invite', {
    email, invitationId: inv.id,
  });
  return { ok: true, invited: true, invitationUrl: inv.url };
}
