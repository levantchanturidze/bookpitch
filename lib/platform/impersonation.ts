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

import { unsafePrismaAdmin } from '@/lib/db';
import { InvalidInputError, ConflictError } from '@/lib/auth';
import type { AuthContext } from '@/lib/rbac';
import { notifyEvent } from '@/lib/notifications';
import { getEmailProvider } from '@/lib/messaging';
import { encryptField, decryptField, hashEmailForIndex } from '@/lib/crypto';
import { log, sanitizeErrorMessage } from '@/lib/logger';

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
  const org = await unsafePrismaAdmin.organization.findUnique({
    where: { id: input.organizationId },
    select: {
      id: true,
      name: true,
      allowSupportImpersonation: true,
      ownerUserId: true,
      ownerUser: { select: { email: true } },
    },
  });
  if (!org) throw new InvalidInputError('organization not found');
  if (!org.allowSupportImpersonation && !input.actor.isBreakGlass) {
    throw new InvalidInputError(
      'organization has disabled support impersonation — enable it in the org settings first',
    );
  }

  // Verify target is actually a member of that org.
  const target = await unsafePrismaAdmin.membership.findFirst({
    where: { userId: input.targetUserId, organizationId: input.organizationId, status: 'active' },
    select: { id: true, user: { select: { email: true, fullName: true } } },
  });
  if (!target) throw new InvalidInputError('target user is not a member of that organization');

  // Anchor to the DB clock so all expiry checks are consistent regardless of
  // Node/server clock divergence. Both the conflict check and the new session's
  // expiresAt use the same DB now().
  const [dbNow] = await unsafePrismaAdmin.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;
  const expiresAt = new Date((dbNow.now as unknown as Date).getTime() + IMPERSONATION_TTL_MS);

  // One active session at a time. Prevents nesting confusion.
  const existing = await unsafePrismaAdmin.impersonationSession.findFirst({
    where: {
      actorUserId: input.actor.userId,
      endedAt: null,
      expiresAt: { gt: dbNow.now as unknown as Date },
    },
    select: { id: true },
  });
  if (existing) throw new ConflictError('you already have an active impersonation session');

  // Session creation, audit log, sessionVersion bump, and alert outbox row in
  // a single transaction. A crash between any of these steps would leave partial
  // state; atomicity ensures they all succeed or all roll back.
  const alertIdempotencyKey = `impersonation.alert:${input.actor.userId}:${input.organizationId}:${Date.now()}`;
  const alertTo = org.ownerUser?.email ?? null;

  const session = await unsafePrismaAdmin.$transaction(async (tx) => {
    const sess = await tx.impersonationSession.create({
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

    await tx.auditLog.create({
      data: {
        organizationId: input.organizationId,
        actorUserId: input.actor.userId,
        onBehalfOfUserId: input.targetUserId,
        action: 'impersonation.start',
        entity: 'staff',
        reason,
        impersonationSessionId: sess.id,
        breakGlassSessionId: input.actor.breakGlass?.sessionId ?? null,
        meta: { ticketId },
      },
    });

    // Bump sessionVersion so the AuthContext cache rebuilds within ~5s and
    // subsequent requests see ctx.impersonation populated.
    await tx.appUser.update({
      where: { id: input.actor.userId },
      data: { sessionVersion: { increment: 1 } },
    });

    // Durable alert email via outbox — written inside the transaction so the
    // row is guaranteed to exist if the session row was committed.
    if (alertTo) {
      const plainBody =
        `A support agent started an impersonation session on your organization "${org.name}".\n\n` +
        `Agent: ${input.actor.email}\n` +
        `Reason: ${reason}\nTicket: ${ticketId}\nExpires: ${expiresAt.toISOString()}\n\n` +
        `If this looks wrong, revoke it from the org settings > audit page or contact security@bookpitch.dev.`;
      const encryptedBody = encryptField(plainBody) ?? plainBody;
      const bodyEncrypted = encryptedBody !== plainBody;
      const toEncrypted = encryptField(alertTo) ?? alertTo;
      const toIsEncrypted = toEncrypted !== alertTo;
      const toHash = hashEmailForIndex(alertTo);
      await tx.emailOutbox.create({
        data: {
          idempotencyKey: alertIdempotencyKey,
          toAddress: toEncrypted,
          toAddressEncrypted: toIsEncrypted,
          toAddressHash: toHash,
          subject: '[Bookpitch] Support agent active in your organization',
          body: encryptedBody,
          bodyEncrypted,
          purpose: 'impersonation.alert',
        },
      });
    }

    return sess;
  });

  // In-app notification for the org owner — best-effort, does not block.
  if (org.ownerUserId) {
    notifyEvent(unsafePrismaAdmin, input.organizationId, {
      type: 'system',
      title: 'Bookpitch support is inside your org',
      body: `A support agent (${input.actor.email}) started an impersonation session. Reason: ${reason} (ticket ${ticketId}). Session ends ${expiresAt.toISOString()}.`,
    }).catch((err: unknown) =>
      log.warn('platform.impersonation.notify_failed', { err: sanitizeErrorMessage(err) }),
    );
  }

  // Attempt immediate drain of the alert row — best-effort, no throw.
  // On failure the row stays pending and housekeeping retries with backoff.
  if (alertTo) {
    try {
      const provider = getEmailProvider();
      type ClaimedRow = {
        id: string;
        to_address: string;
        to_address_encrypted: boolean;
        subject: string;
        body: string;
        body_encrypted: boolean;
      };
      const [claimed] = await unsafePrismaAdmin.$queryRaw<ClaimedRow[]>`
        UPDATE email_outbox
        SET status = 'processing',
            claim_owner = 'impersonation_immediate',
            claim_expires_at = now() + interval '120 seconds',
            claimed_at = now()
        WHERE idempotency_key = ${alertIdempotencyKey} AND status = 'pending'
        RETURNING id, to_address, to_address_encrypted, subject, body, body_encrypted
      `;
      if (claimed) {
        const toAddress = claimed.to_address_encrypted
          ? (decryptField(claimed.to_address) ?? claimed.to_address)
          : claimed.to_address;
        const body = claimed.body_encrypted
          ? (decryptField(claimed.body) ?? claimed.body)
          : claimed.body;
        await provider.send(toAddress, claimed.subject, body);
        await unsafePrismaAdmin.$executeRaw`
          UPDATE email_outbox
          SET status = 'sent', sent_at = now(), claim_owner = NULL
          WHERE id = ${claimed.id}::uuid
        `;
      }
    } catch (err) {
      log.warn('platform.impersonation.alert_drain_failed', { err: sanitizeErrorMessage(err) });
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

  await unsafePrismaAdmin.$transaction(async (tx) => {
    await tx.impersonationSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), endedReason: reason },
    });

    await tx.auditLog.create({
      data: {
        organizationId: actor.impersonation!.organizationId,
        actorUserId: actor.userId,
        onBehalfOfUserId: actor.impersonation!.onBehalfOfUserId,
        action: 'impersonation.end',
        entity: 'staff',
        reason,
        impersonationSessionId: sessionId,
      },
    });

    await tx.appUser.update({
      where: { id: actor.userId },
      data: { sessionVersion: { increment: 1 } },
    });
  });

  log.info('platform.impersonation.end', { sessionId, actorUserId: actor.userId });
  return { ok: true };
}
