import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { unsafePrismaAdmin } from '@/lib/db';
import { encryptField, decryptField, hashEmailForIndex } from '@/lib/crypto';
import { getEmailProvider, type EmailProvider } from './index';
import { log, sanitizeErrorMessage } from '@/lib/logger';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
type RawCapable = Pick<TxClient, '$executeRaw'>;

// -----------------------------------------------------------------------------
// Terminal states, and what each one means.
//
//   sent       the provider accepted it
//   dead       delivery FAILED for good (retries exhausted). The production
//              monitor's `outbox-dead-letters` check and the soak's
//              `outbox-clean` gate alarm on any of these.
//   cancelled  WITHDRAWN before delivery, on purpose: a newer message made it
//              obsolete (failure_category 'superseded'). Not a failure, so it
//              must never be counted as one.
//
// Superseded mail used to be marked `dead`, which meant a user requesting a
// second password reset while the first was still queued would open a
// dead-letter incident — and, during a soak, fail its outbox-clean gate. One
// state, two meanings, is how a monitor learns to cry wolf.
// -----------------------------------------------------------------------------

/** Purpose of every email that carries an onboarding verification link. */
export const VERIFICATION_EMAIL_PURPOSE = 'onboard.verify';

/**
 * Idempotency key for an email carrying an onboarding verification link:
 *
 *   onboard_verify:<email sha256, 16 hex>:<token hash, 16 hex>   (sign-up)
 *   onboard_resend:<email sha256, 16 hex>:<token hash, 16 hex>   (resend)
 *
 * The LAST segment is the first 16 hex characters of the SHA-256 that the
 * link's token hashes to — the prefix pending_registrations.token_hash starts
 * with. That is what lets the outbox tell, without decrypting anything, whether
 * a queued email still carries the CURRENT link (VERIFICATION_LINK_IS_CURRENT).
 * The format is the one these rows have always had, so mail queued before this
 * code shipped is recognised too.
 */
export function verificationEmailKey(
  kind: 'verify' | 'resend',
  email: string,
  tokenHash: string,
): string {
  const emailHash = createHash('sha256').update(email).digest('hex').slice(0, 16);
  return `onboard_${kind}:${emailHash}:${tokenHash.slice(0, 16)}`;
}

/**
 * SQL, for an `email_outbox o` row of VERIFICATION_EMAIL_PURPOSE: TRUE while
 * the link it carries is its registration's current, unexpired token. FALSE
 * once that token has been rotated (resend, repeat sign-up), used (the account
 * was activated — the pending row is deleted) or has expired. On the database
 * clock, like every other expiry comparison in this codebase.
 */
const VERIFICATION_LINK_IS_CURRENT = Prisma.sql`EXISTS (
  SELECT 1 FROM pending_registrations pr
   WHERE left(pr.token_hash, 16) = split_part(o.idempotency_key, ':', 3)
     AND pr.expires_at > transaction_timestamp())`;

/**
 * SQL: an `email_outbox o` row a claim may take — anything except a
 * verification email whose link is stale. Evaluated in the claiming statement
 * itself, so a resend that lands between a stale-row sweep and the claim still
 * cannot get the old link sent.
 */
export const OUTBOX_CLAIMABLE_SQL = Prisma.sql`(o.purpose <> ${VERIFICATION_EMAIL_PURPOSE} OR ${VERIFICATION_LINK_IS_CURRENT})`;

/**
 * Withdraw queued verification emails whose link is no longer current.
 *
 * Supersession at RESEND time only reaches rows that are `pending` at that
 * moment. A row that was mid-send (`processing`) and then failed goes back to
 * `pending` for a retry — still carrying the link the resend just killed — and
 * a row can also outlive its token's expiry, or the account's activation,
 * while it waits for a scheduled drain. Delivering any of those sends the user
 * a dead link. So every delivery path re-asks, immediately before claiming:
 * is this link still the current one?
 *
 * Only `pending` rows are touched: a `processing` row is mid-send, and its
 * outcome comes back through this check if it fails. Pass `idempotencyKey` to
 * limit it to one row.
 */
export async function cancelObsoleteVerificationEmails(
  client: RawCapable,
  idempotencyKey?: string,
): Promise<number> {
  const n = await client.$executeRaw`
    UPDATE email_outbox o
       SET status           = 'cancelled',
           failure_category = 'superseded',
           failed_at        = NOW(),
           last_error       = 'verification link no longer current',
           claim_owner      = NULL
     WHERE o.status = 'pending'
       AND o.purpose = ${VERIFICATION_EMAIL_PURPOSE}
       ${idempotencyKey === undefined ? Prisma.empty : Prisma.sql`AND o.idempotency_key = ${idempotencyKey}`}
       AND NOT ${VERIFICATION_LINK_IS_CURRENT}
  `;
  return Number(n);
}

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
 * Withdraw still-pending rows for this (purpose, recipient), because a newer
 * message has superseded them. They become `cancelled` — withdrawn, NOT failed
 * (see the terminal states above).
 *
 * Password reset and onboarding verification both need this. Issuing a new
 * token invalidates the previous one, so a queued-but-undelivered earlier
 * email would arrive carrying a link that is already dead. Superseding it
 * means the user gets one working link instead of one working and one broken.
 * Call it in the SAME transaction that issues the new token and queues the new
 * email, so the old mail is withdrawn exactly when its replacement exists.
 *
 * Matches on the address HMAC, so nothing has to be decrypted. Rows already
 * claimed by a worker (`processing`) are left alone: that send is in flight.
 * For verification mail, cancelObsoleteVerificationEmails() catches one that
 * fails and comes back.
 */
export async function supersedePendingEmails(
  tx: TxClient,
  purpose: string,
  to: string,
): Promise<number> {
  const hash = hashEmailForIndex(to);
  const n = await tx.$executeRaw`
    UPDATE email_outbox
    SET status = 'cancelled',
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
  purpose: string;
};

/**
 * Send one row this worker has CLAIMED (`processing`). The one place both
 * delivery paths, deliverNow() and the housekeeping drain, hand mail to the
 * provider. Throws what the provider throws; the caller settles the row.
 *
 * Returns false, sending nothing, for a verification email whose link went
 * stale AFTER the claim. The claim checked the link (OUTBOX_CLAIMABLE_SQL),
 * but a resend that commits after it withdraws only `pending` rows: this one
 * is `processing`, so it used to go out carrying the link the resend had just
 * killed (Codex review on #115). The drain sends its batch one row at a time,
 * so for a row near the end that window was every earlier provider call. It is
 * now re-asked here, in one statement that withdraws the row as superseded if
 * the link is stale.
 *
 * What remains: a resend committing while the provider call itself is in
 * flight cannot recall that email. Its link is dead by then, and the
 * replacement is already queued.
 */
export async function sendClaimedEmail(
  provider: Pick<EmailProvider, 'send'>,
  row: ClaimedRow,
): Promise<boolean> {
  if (row.purpose === VERIFICATION_EMAIL_PURPOSE) {
    const withdrawn = await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox o
         SET status           = 'cancelled',
             failure_category = 'superseded',
             failed_at        = NOW(),
             last_error       = 'verification link no longer current',
             claim_owner      = NULL
       WHERE o.id = ${row.id}::uuid
         AND o.status = 'processing'
         AND NOT ${VERIFICATION_LINK_IS_CURRENT}
    `;
    if (Number(withdrawn) > 0) return false;
  }
  const to = row.to_address_encrypted
    ? (decryptField(row.to_address) ?? row.to_address)
    : row.to_address;
  const body = row.body_encrypted ? (decryptField(row.body) ?? row.body) : row.body;
  await provider.send(to, row.subject, body);
  return true;
}

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
    // A stale verification link is withdrawn rather than left `pending` for a
    // drain that would only withdraw it later. A no-op for any other row.
    await cancelObsoleteVerificationEmails(unsafePrismaAdmin, idempotencyKey);
    const [claimed] = await unsafePrismaAdmin.$queryRaw<ClaimedRow[]>`
      UPDATE email_outbox o
      SET status = 'processing',
          claim_owner = 'immediate',
          claim_expires_at = now() + interval '120 seconds',
          claimed_at = now()
      WHERE o.idempotency_key = ${idempotencyKey}
        AND o.status = 'pending'
        AND ${OUTBOX_CLAIMABLE_SQL}
      RETURNING o.id, o.to_address, o.to_address_encrypted, o.subject, o.body, o.body_encrypted,
                o.purpose
    `;
    if (!claimed) return false;

    try {
      // False: a verification link that went stale after the claim. The row
      // is withdrawn, so there is nothing to settle.
      if (!(await sendClaimedEmail(getEmailProvider(), claimed))) return false;
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
