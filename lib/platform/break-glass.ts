// -----------------------------------------------------------------------------
// RBAC Phase 5 — break-glass session lifecycle (spec §7.2).
//
// Only SUPER_ADMIN can activate. Password re-verification is mandatory
// at the moment of use, regardless of session age. 60-minute expiry.
// Every subsequent READ during the window is audited via
// withPlatformApi (see lib/rbac/guard.ts::auditBreakGlassRead).
//
// See docs/rbac-guarding-endpoints.md Phase 5 section for how routes
// composed with withPlatformApi automatically wire the read-audit.
//
// TODO(Phase 5 v2): spec §7.2 rule 3 requires 2FA as well as password.
// The MVP verifies password only — mfa_enabled=true on the SUPER_ADMIN
// row is the marker for the day we install otplib and add a totpCode
// parameter to startBreakGlass.
// -----------------------------------------------------------------------------

import { prismaAdmin } from '@/lib/db';
import { InvalidInputError, ConflictError, ForbiddenError } from '@/lib/auth';
import type { AuthContext } from '@/lib/rbac';
import { verifyPasswordFresh } from './password-reauth';
import { getEmailProvider } from '@/lib/messaging';
import { log } from '@/lib/logger';

export const BREAK_GLASS_TTL_MS = 60 * 60 * 1000; // 60 minutes — spec §7.2 rule 4

export type StartBreakGlassInput = {
  actor: AuthContext;
  password: string;
  reason: string;
  ticketId: string;
  targetOrganizationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export async function startBreakGlass(input: StartBreakGlassInput) {
  const reason = input.reason.trim();
  const ticketId = input.ticketId.trim();
  if (reason.length < 5) throw new InvalidInputError('reason must be at least 5 characters');
  if (ticketId.length < 1) throw new InvalidInputError('ticketId is required');

  // SUPER_ADMIN only. Roles check the caller's platform perms — SUPER_ADMIN
  // has `platform.impersonate` per seed but we want a stricter check:
  // only SUPER_ADMIN can break glass. Query the role key directly.
  const actorUser = await prismaAdmin.appUser.findUniqueOrThrow({
    where: { id: input.actor.userId },
    select: { platformRole: { select: { key: true } } },
  });
  if (actorUser.platformRole?.key !== 'SUPER_ADMIN') {
    throw new ForbiddenError('break-glass is SUPER_ADMIN only');
  }

  // Spec §7.2 rule 3: re-authenticate at the moment of use.
  await verifyPasswordFresh(input.actor.userId, input.password, { throwOnBadPassword: true });

  // One active session at a time.
  const existing = await prismaAdmin.breakGlassSession.findFirst({
    where: { actorUserId: input.actor.userId, endedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (existing) throw new ConflictError('you already have an active break-glass session');

  // If a targetOrganizationId is provided, verify it exists (fail loud on
  // typos; the session becomes queryable regardless).
  if (input.targetOrganizationId) {
    const org = await prismaAdmin.organization.findUnique({
      where: { id: input.targetOrganizationId }, select: { id: true },
    });
    if (!org) throw new InvalidInputError('target organization not found');
  }

  const expiresAt = new Date(Date.now() + BREAK_GLASS_TTL_MS);
  const session = await prismaAdmin.breakGlassSession.create({
    data: {
      actorUserId: input.actor.userId,
      targetOrganizationId: input.targetOrganizationId ?? null,
      reason,
      ticketId,
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });

  // Audit row for the activation itself. If a target org is set, tag the
  // row to that org; otherwise it's a platform-scoped audit (org_id null).
  await prismaAdmin.auditLog.create({
    data: {
      organizationId: input.targetOrganizationId ?? null,
      actorUserId: input.actor.userId,
      action: 'break_glass.start',
      entity: 'staff',
      reason,
      breakGlassSessionId: session.id,
      meta: { ticketId, expiresAt: expiresAt.toISOString() },
    },
  });

  // Bump sessionVersion so the AuthContext cache picks up the new
  // ctx.breakGlass within ~5s.
  await prismaAdmin.appUser.update({
    where: { id: input.actor.userId },
    data: { sessionVersion: { increment: 1 } },
  });

  // Security alert email — the person who owns the SUPER_ADMIN account
  // gets a heads-up on every activation so a compromised session
  // surfaces immediately. SECURITY_ALERT_EMAIL env var; defaults to the
  // caller's own email if unset (better than silent).
  const alertTo = process.env.SECURITY_ALERT_EMAIL ?? input.actor.email;
  try {
    const provider = getEmailProvider();
    await provider.send(
      alertTo,
      '[Bookpitch] Break-glass session activated',
      `A SUPER_ADMIN break-glass session was activated.\n\n` +
      `Actor: ${input.actor.email}\n` +
      `Ticket: ${ticketId}\n` +
      `Reason: ${reason}\n` +
      `Target org: ${input.targetOrganizationId ?? '(platform-wide)'}\n` +
      `Expires: ${expiresAt.toISOString()}\n\n` +
      `If this wasn't you, reset your password immediately.`,
    );
  } catch (err) {
    log.warn('platform.break_glass.alert_failed', { err: (err as Error).message });
  }

  log.info('platform.break_glass.start', {
    sessionId: session.id, actorUserId: input.actor.userId,
    targetOrganizationId: input.targetOrganizationId ?? null,
  });

  return { sessionId: session.id, expiresAt };
}

export async function endBreakGlass(actor: AuthContext, reason: string = 'user_end') {
  if (!actor.breakGlass) {
    throw new InvalidInputError('no active break-glass session');
  }
  const sessionId = actor.breakGlass.sessionId;

  await prismaAdmin.breakGlassSession.update({
    where: { id: sessionId },
    data: { endedAt: new Date(), endedReason: reason },
  });

  await prismaAdmin.auditLog.create({
    data: {
      organizationId: actor.breakGlass.targetOrganizationId ?? null,
      actorUserId: actor.userId,
      action: 'break_glass.end',
      entity: 'staff',
      reason,
      breakGlassSessionId: sessionId,
    },
  });

  await prismaAdmin.appUser.update({
    where: { id: actor.userId },
    data: { sessionVersion: { increment: 1 } },
  });

  log.info('platform.break_glass.end', { sessionId, actorUserId: actor.userId });
  return { ok: true };
}

/**
 * Write an audit row for a read that happened during a break-glass
 * session (spec §7.2 rule 6). Called from withPlatformApi wrapper for
 * every request when ctx.breakGlass is set. Cheap — one INSERT.
 */
export async function auditBreakGlassRead(
  actor: AuthContext,
  action: string,
  meta: Record<string, string | number | boolean | null> = {},
) {
  if (!actor.breakGlass) return;
  await prismaAdmin.auditLog.create({
    data: {
      organizationId: actor.breakGlass.targetOrganizationId ?? null,
      actorUserId: actor.userId,
      action: `break_glass.read.${action}`,
      entity: 'staff',
      breakGlassSessionId: actor.breakGlass.sessionId,
      meta,
    },
  });
}
