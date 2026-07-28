// -----------------------------------------------------------------------------
// RBAC Phase 5 — impersonation session lifecycle (spec §7.1).
//
// Start:
//   1. Verify caller has `platform.impersonate` (guard's job — caller enforces
//      before calling here).
//   2. Verify org.allow_support_impersonation, unless caller is in a
//      break-glass session (SUPER_ADMIN can override — spec §6.1).
//   3. Verify no active impersonation for this actor (one at a time).
//   4. Write impersonation_sessions row with 60-min expiry, mandatory
//      reason + ticketId.
//   5. Write audit row (impersonation.start) with impersonation_session_id.
//   6. Bump caller's sessionVersion → AuthContext cache invalidates within
//      5s, next request sees ctx.impersonation populated.
//   7. Notify the target org's owner: notification row + email (best-effort).
//
// End: mark ended_at, bump sessionVersion, audit.
//
// Timeout: no dedicated sweep. `buildAuthContext` filters expired rows
// (WHERE ended_at IS NULL AND expires_at > now()) so an expired session
// silently drops out of the ctx. A separate housekeeping job could flip
// ended_at on expired rows for cleanliness; not required for correctness.
// -----------------------------------------------------------------------------

import { prismaAdmin } from '@/lib/db';
import { InvalidInputError, ConflictError } from '@/lib/auth';
import type { AuthContext } from '@/lib/rbac';
import { notifyEvent } from '@/lib/notifications';
import { getEmailProvider } from '@/lib/messaging';
import { log } from '@/lib/logger';

export const IMPERSONATION_TTL_MS = 60 * 60 * 1000; // 60 minutes — spec §7.1

export type StartImpersonationInput = {
  actor: AuthContext;
  targetUserId: string;
  organizationId: string;
  reason: string;
  ticketId: string;
  ip?: string | null;
  userAgent?: string | null;
};

export async function startImpersonation(input: StartImpersonationInput) {
  const reason = input.reason.trim();
  const ticketId = input.ticketId.trim();
  if (reason.length < 5) throw new InvalidInputError('reason must be at least 5 characters');
  if (ticketId.length < 1) throw new InvalidInputError('ticketId is required');

  // Verify org exists + impersonation is allowed (unless caller is in
  // break-glass — spec §6.1 row "override").
  const org = await prismaAdmin.organization.findUnique({
    where: { id: input.organizationId },
    select: { id: true, name: true, allowSupportImpersonation: true, ownerUserId: true, ownerUser: { select: { email: true } } },
  });
  if (!org) throw new InvalidInputError('organization not found');
  if (!org.allowSupportImpersonation && !input.actor.isBreakGlass) {
    throw new InvalidInputError(
      'organization has disabled support impersonation — enable it in the org settings first',
    );
  }

  // Verify target is actually a member of that org.
  const target = await prismaAdmin.membership.findFirst({
    where: { userId: input.targetUserId, organizationId: input.organizationId, status: 'active' },
    select: { id: true, user: { select: { email: true, fullName: true } } },
  });
  if (!target) throw new InvalidInputError('target user is not a member of that organization');

  // One active session at a time. Prevents nesting confusion.
  const existing = await prismaAdmin.impersonationSession.findFirst({
    where: { actorUserId: input.actor.userId, endedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (existing) throw new ConflictError('you already have an active impersonation session');

  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS);
  const session = await prismaAdmin.impersonationSession.create({
    data: {
      actorUserId: input.actor.userId,
      onBehalfOfUserId: input.targetUserId,
      organizationId: input.organizationId,
      reason,
      ticketId,
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });

  await prismaAdmin.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.actor.userId,
      onBehalfOfUserId: input.targetUserId,
      action: 'impersonation.start',
      entity: 'staff',
      reason,
      impersonationSessionId: session.id,
      breakGlassSessionId: input.actor.breakGlass?.sessionId ?? null,
      meta: { ticketId },
    },
  });

  // Bump sessionVersion so the AuthContext cache rebuilds within ~5s and
  // subsequent requests see ctx.impersonation populated.
  await prismaAdmin.appUser.update({
    where: { id: input.actor.userId },
    data: { sessionVersion: { increment: 1 } },
  });

  // Notify the target org's owner (spec §7.1 rule 7). Best-effort: a
  // notification row is written (visible in their notifications panel);
  // an email is sent if the provider is configured. Neither failure blocks
  // the impersonation itself.
  if (org.ownerUserId) {
    try {
      await notifyEvent(prismaAdmin, input.organizationId, {
        type: 'system',
        title: 'Bookpitch support is inside your org',
        body: `A support agent (${input.actor.email}) started an impersonation session at ${session.startedAt.toISOString()}. Reason: ${reason} (ticket ${ticketId}). Session ends ${expiresAt.toISOString()}.`,
      });
    } catch (err) {
      log.warn('platform.impersonation.notify_failed', { err: (err as Error).message });
    }
  }
  if (org.ownerUser?.email) {
    try {
      const provider = getEmailProvider();
      await provider.send(
        org.ownerUser.email,
        'Bookpitch support is inside your organization',
        `A support agent started an impersonation session on your organization "${org.name}".\n\n` +
        `Reason: ${reason}\nTicket: ${ticketId}\nExpires: ${expiresAt.toISOString()}\n\n` +
        `If this looks wrong, revoke it from the org settings > audit page or contact security@bookpitch.dev.`,
      );
    } catch (err) {
      log.warn('platform.impersonation.email_failed', { err: (err as Error).message });
    }
  }

  log.info('platform.impersonation.start', {
    sessionId: session.id,
    actorUserId: input.actor.userId,
    targetUserId: input.targetUserId,
    organizationId: input.organizationId,
  });

  return { sessionId: session.id, expiresAt };
}

export async function endImpersonation(actor: AuthContext, reason: string = 'user_end') {
  if (!actor.impersonation) {
    throw new InvalidInputError('no active impersonation session');
  }
  const sessionId = actor.impersonation.sessionId;

  await prismaAdmin.impersonationSession.update({
    where: { id: sessionId },
    data: { endedAt: new Date(), endedReason: reason },
  });

  await prismaAdmin.auditLog.create({
    data: {
      organizationId: actor.impersonation.organizationId,
      actorUserId: actor.userId,
      onBehalfOfUserId: actor.impersonation.onBehalfOfUserId,
      action: 'impersonation.end',
      entity: 'staff',
      reason,
      impersonationSessionId: sessionId,
    },
  });

  await prismaAdmin.appUser.update({
    where: { id: actor.userId },
    data: { sessionVersion: { increment: 1 } },
  });

  log.info('platform.impersonation.end', { sessionId, actorUserId: actor.userId });
  return { ok: true };
}
