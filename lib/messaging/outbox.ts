import type { PrismaClient } from '@prisma/client';
import { unsafePrismaAdmin } from '@/lib/db';
import { encryptField, decryptField, hashEmailForIndex } from '@/lib/crypto';
import { getEmailProvider } from './index';
import { log, sanitizeErrorMessage } from '@/lib/logger';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

// -----------------------------------------------------------------------------
// P17-002 — the durable-email helper.
//
// Bookpitch had two ways to send a transactional email:
//
//   • Durable. Write a row to `email_outbox` inside the transaction that
//     caused it, try to deliver immediately, and let the housekeeping drain
//     retry with exponential backoff and dead-letter after max_attempts.
//     Used by onboarding, break-glass, impersonation, MFA and the audit digest.
//
//   • Direct. Call `provider.send()` and catch the error. Used by password
//     reset, invitations and ownership transfer.
//
// The second one loses mail silently. lib/auth/password-reset.ts caught the
// provider failure, wrote `log.warn('password_reset.request.provider_failed')`,
// and returned normally — the route then answered 202 "if the address exists,
// we sent a link". Nothing retried. Nothing alerted. The user waits for an
// email that no longer exists anywhere, and the only trace is one warn line in
// a log nobody reads. During the current GitHub Actions billing suspension the
// housekeeping cron is not running either, which is exactly the kind of outage
// where a retry queue earns its keep.
//
// This module is the durable path as a function, so a new caller gets retries,
// backoff, dead-lettering and the monitor's dead-letter alarm by default
// rather than by remembering to hand-roll fifty lines.
//
// Deliberately NOT applied to the five existing durable callers. They work,
// they are covered by tests, and rewriting break-glass / MFA / impersonation
// delivery during a stabilization phase buys nothing. Consolidating them is a
// Phase 18 item.
// -----------------------------------------------------------------------------

export type EnqueueEmailInput = {
  /**
   * Stable key for this specific message. The DB enforces uniqueness via a
   * sparse index (migration 20260813000005), so enqueuing the same key twice
   * inside a transaction rolls that transaction back rather than sending two
   * copies. Include something that changes per intended send — a token hash,
   * a session id — never just the recipient.
   */
  idempotencyKey: string;
  to: string;
  subject: string;
  body: string;
  /** Dotted category, e.g. `password_reset.link`. Shows up in ops metrics. */
  purpose: string;
  /**
   * Retry budget. Defaults to the column default (3). Lower it for mail whose
   * contents expire — retrying a one-hour reset link for a day delivers a dead
   * link to a confused user.
   */
  maxAttempts?: number;
};

/**
 * Write one email to the durable outbox. Call inside the transaction that
 * produced the reason for the email, so the mail and the state change commit
 * or roll back together.
 *
 * Body and recipient are encrypted at rest with FIELD_ENCRYPTION_KEY when one
 * is configured, matching lib/onboarding.ts — these bodies carry verification
 * and reset links. `toAddressHash` is an HMAC of the lowercase address so rows
 * can be found by recipient without decrypting anything.
 */
export async function enqueueEmail(tx: TxClient, input: EnqueueEmailInput): Promise<void> {
  const encryptedBody = encryptField(input.body) ?? input.body;
  const encryptedTo = encryptField(input.to) ?? input.to;
  await tx.emailOutbox.create({
    data: {
      idempotencyKey: input.idempotencyKey,
      toAddress: encryptedTo,
      toAddressEncrypted: encryptedTo !== input.to,
      toAddressHash: hashEmailForIndex(input.to),
      subject: input.subject,
      body: encryptedBody,
      bodyEncrypted: encryptedBody !== input.body,
      purpose: input.purpose,
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
    },
  });
}

/**
 * Mark still-pending rows for this (purpose, recipient) as dead, because a
 * newer message has superseded them.
 *
 * Password reset needs this. Requesting a second reset invalidates the first
 * token — `requestPasswordReset` deletes prior verification_tokens rows — so a
 * queued-but-undelivered first email would arrive carrying a link that is
 * already dead. Superseding it means the user gets one working link instead of
 * one working and one broken.
 *
 * Matches on the address HMAC, so nothing has to be decrypted. Rows already
 * claimed by a worker (`processing`) are left alone: that send is in flight.
 */
export async function supersedePendingEmails(
  tx: TxClient,
  purpose: string,
  to: string,
): Promise<number> {
  const hash = hashEmailForIndex(to);
  const n = await tx.$executeRaw`
    UPDATE email_outbox
    SET status = 'dead',
        failed_at = NOW(),
        last_error = 'superseded by a newer message',
        failure_category = 'superseded',
        claim_owner = NULL
    WHERE status = 'pending'
      AND purpose = ${purpose}
      AND to_address_hash = ${hash}
  `;
  return Number(n);
}

type ClaimedRow = {
  id: string;
  to_address: string;
  to_address_encrypted: boolean;
  subject: string;
  body: string;
  body_encrypted: boolean;
};

/**
 * Best-effort immediate delivery of one enqueued row, after its transaction
 * has committed. Never throws.
 *
 * Claims via `UPDATE … RETURNING` so a housekeeping worker racing for the same
 * row cannot send a duplicate. On any failure the row is returned to `pending`
 * and the drain retries it with backoff — which is the entire point of writing
 * it down first.
 *
 * Returns true only when the provider accepted the message.
 */
export async function deliverNow(idempotencyKey: string, purpose: string): Promise<boolean> {
  try {
    const [claimed] = await unsafePrismaAdmin.$queryRaw<ClaimedRow[]>`
      UPDATE email_outbox
      SET status = 'processing',
          claim_owner = 'immediate',
          claim_expires_at = now() + interval '120 seconds',
          claimed_at = now()
      WHERE idempotency_key = ${idempotencyKey} AND status = 'pending'
      RETURNING id, to_address, to_address_encrypted, subject, body, body_encrypted
    `;
    if (!claimed) return false;

    const to = claimed.to_address_encrypted
      ? (decryptField(claimed.to_address) ?? claimed.to_address)
      : claimed.to_address;
    const body = claimed.body_encrypted
      ? (decryptField(claimed.body) ?? claimed.body)
      : claimed.body;

    try {
      const provider = getEmailProvider();
      await provider.send(to, claimed.subject, body);
    } catch (err) {
      // Hand the row back so the drain retries it with backoff. Without this
      // it sits in `processing` until its claim lease expires — recoverable,
      // but two minutes slower for no reason.
      await unsafePrismaAdmin.$executeRaw`
        UPDATE email_outbox
        SET status = 'pending',
            attempts = attempts + 1,
            next_attempt_at = NOW() + interval '60 seconds',
            last_error = ${sanitizeErrorMessage(err)},
            failure_category = 'provider_error',
            claim_owner = NULL
        WHERE id = ${claimed.id}::uuid
      `;
      // Not an error: the message is still queued and will be retried. The
      // alarm for mail that never lands is the outbox dead-letter count in
      // lib/ops-metrics.ts, not this line.
      log.warn('outbox.immediate_delivery_failed', {
        purpose,
        error: sanitizeErrorMessage(err),
      });
      return false;
    }

    await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox
      SET status = 'sent', sent_at = now(), claim_owner = NULL
      WHERE id = ${claimed.id}::uuid
    `;
    return true;
  } catch (err) {
    // A failure of the claim/settle machinery itself. The row is durable
    // either way, so this is recoverable — but it is not routine.
    log.error('outbox.immediate_delivery_error', {
      purpose,
      error: sanitizeErrorMessage(err),
    });
    return false;
  }
}
