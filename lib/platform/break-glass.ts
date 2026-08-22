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
// -----------------------------------------------------------------------------

import { dbNowMs, unsafePrismaAdmin } from '@/lib/db';
import { InvalidInputError, ConflictError, ForbiddenError } from '@/lib/auth';
import { Prisma } from '@prisma/client';
import type { AuthContext } from '@/lib/rbac';
import { verifyPasswordDirect } from './password-reauth';
import { preCheckTotp, preCheckRecoveryCode } from './mfa';
import { getEmailProvider } from '@/lib/messaging';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import { encryptField, decryptField, hashEmailForIndex } from '@/lib/crypto';

export const BREAK_GLASS_TTL_MS = 60 * 60 * 1000; // 60 minutes — spec §7.2 rule 4

export type StartBreakGlassInput = {
  actor: AuthContext;
  password: string;
  /** TOTP code from the authenticator app. Exactly one of totpCode / recoveryCode is required. */
  totpCode?: string;
  /** Single-use backup recovery code. Alternative to totpCode when the app is unavailable. */
  recoveryCode?: string;
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
  const actorUser = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { id: input.actor.userId },
    select: { platformRole: { select: { key: true } } },
  });
  if (actorUser.platformRole?.key !== 'SUPER_ADMIN') {
    throw new ForbiddenError('break-glass is SUPER_ADMIN only');
  }

  // Spec §7.2 rule 3: re-authenticate at the moment of use (password + 2FA).
  // 2FA may be a TOTP code from the authenticator app or a single-use recovery
  // code — exactly one must be supplied.
  if (!input.totpCode && !input.recoveryCode) {
    throw new InvalidInputError('totpCode or recoveryCode is required');
  }
  if (input.totpCode && input.recoveryCode) {
    throw new InvalidInputError('supply only one of totpCode or recoveryCode, not both');
  }

  await verifyPasswordDirect(input.actor.userId, input.password, { throwOnBadPassword: true });

  // Pre-check phase: rate-limit + validate credentials but do NOT commit any
  // state. The state-changing operations (fence-advance / mark-used) happen
  // atomically inside the session-creation transaction below so that a
  // failure anywhere rolls back the credential consumption together with
  // everything else — no orphaned consumed codes or advanced replay fences.
  let totpWindow: bigint | null = null;
  let recoveryCodeHash: string | null = null;
  if (input.totpCode) {
    totpWindow = await preCheckTotp(input.actor.userId, input.totpCode);
  } else {
    recoveryCodeHash = await preCheckRecoveryCode(input.actor.userId, input.recoveryCode!);
  }

  // Full atomic transaction: eligibility check, credential commit,
  // session creation, audit log, sessionVersion bump.
  // expiresAt uses DB clock to prevent Node clock-skew pre-expiry.
  // The partial unique index idx_break_glass_sessions_actor_active enforces
  // one active session per actor at the DB level. A concurrent INSERT that
  // races past the app-level findFirst check will hit P2002; we translate
  // that to ConflictError so callers get the same error from either path.
  let txResult: Awaited<ReturnType<typeof runBreakGlassTx>>;
  try {
    txResult = await runBreakGlassTx();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError('you already have an active break-glass session');
    }
    throw err;
  }
  const { session, expiresAt, alertIdempotencyKey } = txResult;

  // Inline function so variable bindings from the outer scope (input, reason, etc.)
  // are captured; the try/catch above converts DB unique-constraint violations to
  // ConflictError without leaking Prisma internals.
  async function runBreakGlassTx() {
    return unsafePrismaAdmin.$transaction(async (tx) => {
      // F16-010: one instant for the whole transaction, obtained as a number so
      // no timezone rendering is involved. Every comparison below either uses
      // transaction_timestamp() inside SQL, or this value through Prisma's model
      // API — never a JS Date bound into raw SQL, which is rendered and
      // re-parsed and was skewed the opposite way to the read.
      const dbNowAt = new Date(await dbNowMs(tx));
      const expiresAt = new Date(dbNowAt.getTime() + BREAK_GLASS_TTL_MS);

      // Atomically sweep DB-expired sessions (ended_at IS NULL but expires_at <= now())
      // for this actor before the uniqueness check. The partial unique index covers
      // ended_at IS NULL, so an unswept expired row would block a legitimate new
      // session even without a concurrent housekeeping worker. Sweeping inside this
      // transaction removes the housekeeping dependency for correctness.
      //
      // Both sides of the comparison stay in SQL: transaction_timestamp() is the
      // same instant dbNowAt reports, so the sweep and the conflict check that
      // follows cannot disagree about whether a row had expired.
      await tx.$executeRaw`
        UPDATE break_glass_sessions
        SET ended_at = transaction_timestamp(), ended_reason = 'auto_expired'
        WHERE actor_user_id = ${input.actor.userId}::uuid
          AND ended_at IS NULL
          AND expires_at <= transaction_timestamp()
      `;

      // One active (not expired) session at a time (inside tx for snapshot
      // consistency). Compared in SQL, like the sweep above: a bound JS Date is
      // re-interpreted in the session TimeZone and off-UTC would let an expired
      // session block a legitimate new one (F16-010).
      const existing = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM break_glass_sessions
        WHERE actor_user_id = ${input.actor.userId}::uuid
          AND ended_at IS NULL
          AND expires_at > transaction_timestamp()
        LIMIT 1
      `;
      if (existing.length > 0) {
        throw new ConflictError('you already have an active break-glass session');
      }

      // Target org validation inside tx.
      if (input.targetOrganizationId) {
        const org = await tx.organization.findUnique({
          where: { id: input.targetOrganizationId },
          select: { id: true },
        });
        if (!org) throw new InvalidInputError('target organization not found');
      }

      // Commit TOTP replay fence — if another request raced us with the same
      // code, this update returns 0 rows and we abort the whole transaction.
      if (totpWindow !== null) {
        const rowsUpdated = await tx.$executeRaw`
        UPDATE app_users
        SET mfa_last_totp_window = ${totpWindow}
        WHERE id = ${input.actor.userId}::uuid
          AND (mfa_last_totp_window IS NULL OR mfa_last_totp_window < ${totpWindow})
      `;
        if (rowsUpdated === 0) {
          throw new InvalidInputError('TOTP code has already been used — wait for the next code');
        }
      }

      // Commit recovery-code mark-used — 0 rows means concurrent use or
      // the code was already consumed before this transaction started.
      if (recoveryCodeHash !== null) {
        const rowsUpdated = await tx.$executeRaw`
        UPDATE app_user_recovery_codes
        SET used_at = now()
        WHERE user_id = ${input.actor.userId}::uuid
          AND code_hash = ${recoveryCodeHash}
          AND used_at IS NULL
      `;
        if (rowsUpdated === 0) {
          throw new InvalidInputError('invalid or already-used recovery code');
        }
      }

      // Invalidate outstanding reauth grants for both TOTP and recovery-code
      // paths — breaking glass is a privilege escalation event that must close
      // any existing reauth window regardless of which 2FA factor was used.
      await tx.platformReauthGrant.deleteMany({ where: { userId: input.actor.userId } });

      const session = await tx.breakGlassSession.create({
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

      await tx.auditLog.create({
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
      await tx.appUser.update({
        where: { id: input.actor.userId },
        data: { sessionVersion: { increment: 1 } },
      });

      // Write the security alert to the email outbox inside the transaction.
      // Idempotency key ties this row to the session: a duplicate key on retry
      // raises a unique-constraint error and rolls back the whole transaction,
      // preventing a second alert from firing for the same session.
      // If the transaction rolls back (bad TOTP replay etc.) no outbox row is
      // written and no spurious alert is ever sent.
      const alertTo = process.env.SECURITY_ALERT_EMAIL ?? input.actor.email;
      const alertIdempotencyKey = `break_glass_alert:${session.id}`;
      const alertPlainBody =
        `A SUPER_ADMIN break-glass session was activated.\n\n` +
        `Actor: ${input.actor.email}\n` +
        `Ticket: ${ticketId}\n` +
        `Reason: ${reason}\n` +
        `Target org: ${input.targetOrganizationId ?? '(platform-wide)'}\n` +
        `Expires: ${expiresAt.toISOString()}\n\n` +
        `If this wasn't you, reset your password immediately.`;
      const alertEncryptedBody = encryptField(alertPlainBody) ?? alertPlainBody;
      const alertBodyEncrypted = alertEncryptedBody !== alertPlainBody;
      const alertToEncrypted = encryptField(alertTo) ?? alertTo;
      const alertToIsEncrypted = alertToEncrypted !== alertTo;
      const alertToHash = hashEmailForIndex(alertTo);
      await tx.emailOutbox.create({
        data: {
          idempotencyKey: alertIdempotencyKey,
          toAddress: alertToEncrypted,
          toAddressEncrypted: alertToIsEncrypted,
          toAddressHash: alertToHash,
          subject: '[Bookpitch] Break-glass session activated',
          body: alertEncryptedBody,
          bodyEncrypted: alertBodyEncrypted,
          purpose: 'break_glass.alert',
        },
      });

      return { session, expiresAt, alertTo, alertIdempotencyKey };
    });
  } // end runBreakGlassTx

  // Attempt immediate drain — best-effort, no throw. Claim atomically via
  // UPDATE … RETURNING to prevent a concurrent housekeeping worker from
  // sending a duplicate. On failure the row remains pending and housekeeping
  // will retry with exponential backoff.
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
          claim_owner = 'break_glass_immediate',
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
    log.warn('platform.break_glass.alert_drain_failed', { err: sanitizeErrorMessage(err) });
  }

  log.info('platform.break_glass.start', {
    sessionId: session.id,
    actorUserId: input.actor.userId,
    targetOrganizationId: input.targetOrganizationId ?? null,
  });

  return { sessionId: session.id, expiresAt };
}

export async function endBreakGlass(actor: AuthContext, reason: string = 'user_end') {
  if (!actor.breakGlass) {
    throw new InvalidInputError('no active break-glass session');
  }
  const sessionId = actor.breakGlass.sessionId;
  const targetOrganizationId = actor.breakGlass.targetOrganizationId;

  await unsafePrismaAdmin.$transaction(async (tx) => {
    // ended_at is written by the database, like expires_at. Ordering between
    // the two has to hold for the sweep and the audit trail to agree.
    await tx.$executeRaw`
      UPDATE break_glass_sessions
      SET ended_at = transaction_timestamp(), ended_reason = ${reason}
      WHERE id = ${sessionId}::uuid
    `;

    await tx.auditLog.create({
      data: {
        organizationId: targetOrganizationId ?? null,
        actorUserId: actor.userId,
        action: 'break_glass.end',
        entity: 'staff',
        reason,
        breakGlassSessionId: sessionId,
      },
    });

    await tx.appUser.update({
      where: { id: actor.userId },
      data: { sessionVersion: { increment: 1 } },
    });
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
  await unsafePrismaAdmin.auditLog.create({
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
