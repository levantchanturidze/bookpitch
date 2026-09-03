import { dbNowMs, unsafePrismaAdmin, withoutRls } from '@/lib/db';
import { getEmailProvider } from '@/lib/messaging';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import { decryptField } from '@/lib/crypto';

// -----------------------------------------------------------------------------
// Housekeeping: prunes rows that are safe to drop once they're stale.
//
// App-level tables:
//   - rate_limit rows older than 1 day
//   - verification_tokens whose `expires` has passed
//   - notifications marked read and older than 30 days
//
// Platform security tables:
//   - platform_rate_limit rows older than 1 day
//   - pending_registrations whose expires_at has passed (unverified signups)
//   - platform_reauth_grant rows that are either consumed or expired
//     (retained 1 day for audit history, then swept)
//   - app_user_recovery_codes that have been used (retained 30 days)
//   - break_glass_sessions that expired without an explicit end (marked ended)
//   - impersonation_sessions that expired without an explicit end (marked ended)
//   - mfa_totp_pending secrets that were never confirmed (24h TTL)
//
// Outbox:
//   - email_outbox pending rows — drained and marked sent or failed
//   - failed rows (failed_at IS NOT NULL) older than 30 days — swept
//
// Advisory lock: pg_try_advisory_xact_lock prevents two concurrent cron
// invocations from doing duplicate work. Returns early with zeros if another
// worker holds the lock (transaction-scoped; released automatically on commit).
//
// Advisory lock key: 7698234761 — stable constant for 'bookpitch.housekeeping'.
// -----------------------------------------------------------------------------

const ONE_DAY_MS = 24 * 3600 * 1000;

// Stable bigint key for pg_try_advisory_xact_lock.
// Must not collide with any other advisory lock in the codebase.
const HOUSEKEEPING_LOCK_KEY = BigInt('7698234761');

export type HousekeepingResult = {
  rateLimit: number;
  verificationTokens: number;
  notifications: number;
  platformRateLimit: number;
  pendingRegistrations: number;
  reauthGrants: number;
  usedRecoveryCodes: number;
  expiredBreakGlassSessions: number;
  expiredImpersonationSessions: number;
  staleMfaEnrollmentChallenges: number;
  outboxSent: number;
  outboxFailed: number;
  outboxSwept: number;
  /** Sweeps that could not run at all (provider init, claim, or sweep threw). */
  outboxInfraFailed: number;
};

const ZERO_RESULT: HousekeepingResult = {
  rateLimit: 0,
  verificationTokens: 0,
  notifications: 0,
  platformRateLimit: 0,
  pendingRegistrations: 0,
  reauthGrants: 0,
  usedRecoveryCodes: 0,
  expiredBreakGlassSessions: 0,
  expiredImpersonationSessions: 0,
  staleMfaEnrollmentChallenges: 0,
  outboxSent: 0,
  outboxFailed: 0,
  outboxSwept: 0,
  outboxInfraFailed: 0,
};

export async function runHousekeeping(): Promise<HousekeepingResult> {
  // Use PostgreSQL time as the authoritative clock for all security decisions.
  // This prevents Node/PostgreSQL clock skew from affecting claim eligibility,
  // retry scheduling, lock expiry, and retention cutoffs.
  // F16-010: as a number. Read as a rendered timestamptz this was four hours
  // ahead off-UTC, which made the sweeps below delete tokens and grants that
  // were still live.
  const now = new Date(await dbNowMs(unsafePrismaAdmin));

  const result = await withoutRls(async (tx) => {
    // ── Advisory lock — prevent concurrent housekeeping runs ──────────────────
    const [lock] = await tx.$queryRaw<[{ acquired: boolean }]>`
      SELECT pg_try_advisory_xact_lock(${HOUSEKEEPING_LOCK_KEY}::bigint) AS acquired
    `;
    if (!lock.acquired) {
      log.info('housekeeping.skipped', { reason: 'advisory_lock_held' });
      return null;
    }

    // ── App-level tables ──────────────────────────────────────────────────────
    //
    // F16-010: every cutoff below is computed and compared inside SQL. Binding a
    // JS Date as a query parameter has it re-interpreted in the session
    // TimeZone, so off-UTC these sweeps deleted rows that were still live —
    // verification tokens and reauth grants among them. `transaction_timestamp()`
    // never leaves the database, and one transaction sees one instant.
    const rateLimit = await tx.$executeRaw`
      DELETE FROM rate_limit WHERE window_start < transaction_timestamp() - interval '1 day'
    `;
    const verificationTokens = await tx.$executeRaw`
      DELETE FROM verification_tokens WHERE expires < transaction_timestamp()
    `;
    const notifications = await tx.$executeRaw`
      DELETE FROM notifications
      WHERE read = true AND created_at < transaction_timestamp() - interval '30 days'
    `;

    // ── Platform security tables ──────────────────────────────────────────────
    const platformRateLimit = await tx.$executeRaw`
      DELETE FROM platform_rate_limit
      WHERE window_start < transaction_timestamp() - interval '1 day'
    `;
    // Pending registrations that were never verified (expired tokens).
    const pendingRegistrations = await tx.$executeRaw`
      DELETE FROM pending_registrations WHERE expires_at < transaction_timestamp()
    `;
    // Reauth grants that are consumed OR expired by more than 1 day.
    const reauthGrants = await tx.$executeRaw`
      DELETE FROM platform_reauth_grant
      WHERE consumed_at < transaction_timestamp() - interval '1 day'
         OR (expires_at < transaction_timestamp() - interval '1 day' AND consumed_at IS NULL)
    `;
    // Used recovery codes — retained 30 days for audit, then swept.
    const usedRecoveryCodes = await tx.$executeRaw`
      DELETE FROM app_user_recovery_codes
      WHERE used_at < transaction_timestamp() - interval '30 days'
    `;

    // ── Platform session cleanup ──────────────────────────────────────────────
    // Break-glass sessions expire at a DB-enforced time but may never get an
    // explicit endBreakGlass call (network failure, crash). Mark them ended so
    // the DB stays clean and audit queries don't need to reason about expiry.
    const bgResult = await tx.$executeRaw`
      UPDATE break_glass_sessions
      SET ended_at = transaction_timestamp(), ended_reason = 'expired_sweep'
      WHERE ended_at IS NULL AND expires_at < transaction_timestamp()
    `;
    // Impersonation sessions: same pattern.
    const impResult = await tx.$executeRaw`
      UPDATE impersonation_sessions
      SET ended_at = transaction_timestamp(), ended_reason = 'expired_sweep'
      WHERE ended_at IS NULL AND expires_at < transaction_timestamp()
    `;

    // ── Stale MFA enrollment challenges ──────────────────────────────────────
    // A SUPER_ADMIN who starts re-enrollment but never confirms their new TOTP
    // secret leaves mfa_totp_pending set. Clear it after 24h so the DB doesn't
    // accumulate abandoned encrypted blobs. The old mfa_totp remains active
    // throughout — this sweep does not affect break-glass access.
    const mfaResult = await tx.$executeRaw`
      UPDATE app_users
      SET mfa_totp_pending = null, mfa_totp_pending_created_at = null
      WHERE mfa_totp_pending IS NOT NULL
        AND mfa_totp_pending_created_at < transaction_timestamp() - interval '1 day'
    `;

    return {
      rateLimit: Number(rateLimit),
      verificationTokens: Number(verificationTokens),
      notifications: Number(notifications),
      platformRateLimit: Number(platformRateLimit),
      pendingRegistrations: Number(pendingRegistrations),
      reauthGrants: Number(reauthGrants),
      usedRecoveryCodes: Number(usedRecoveryCodes),
      expiredBreakGlassSessions: Number(bgResult),
      expiredImpersonationSessions: Number(impResult),
      staleMfaEnrollmentChallenges: Number(mfaResult),
    };
  });

  if (result === null) {
    return ZERO_RESULT;
  }

  // ── Email outbox drain ────────────────────────────────────────────────────
  // Done outside the advisory-locked transaction because email I/O must not
  // hold a DB transaction open. The advisory lock (pg_try_advisory_xact_lock)
  // is transaction-scoped and is released when the tx above commits — it does
  // NOT cover the drain. Concurrent drain workers are instead prevented by the
  // atomic claim inside drainEmailOutbox (FOR UPDATE SKIP LOCKED): each row is
  // claimed by exactly one worker at a time regardless of concurrency.
  const outboxResult = await drainEmailOutbox(now);

  const final: HousekeepingResult = { ...result, ...outboxResult };
  log.info('housekeeping.ok', final);
  return final;
}

// Exponential backoff constants for outbox retries.
const OUTBOX_CLAIM_TTL_SECONDS = 120; // stale claim recovery after 2 min
const OUTBOX_BASE_BACKOFF_SECONDS = 60; // 1 min base; doubles per attempt
const OUTBOX_JITTER_SECONDS = 30; // uniform jitter [0, 30)
const OUTBOX_BATCH_SIZE = 10;

type OutboxRow = {
  id: string;
  to_address: string;
  to_address_encrypted: boolean;
  subject: string;
  body: string;
  body_encrypted: boolean;
  purpose: string;
  attempts: number;
  max_attempts: number;
};

async function drainEmailOutbox(now: Date): Promise<{
  outboxSent: number;
  outboxFailed: number;
  outboxSwept: number;
  /**
   * The drain could not RUN — provider initialisation threw, or the stale-claim
   * recovery / claim transaction failed. Distinct from a per-recipient delivery
   * failure, which is routine and handled by retry and dead-lettering.
   *
   * Without this the catch below returned zeroes and the caller wrote a
   * successful heartbeat: a total inability to send mail was indistinguishable
   * from an empty queue.
   */
  outboxInfraFailed: number;
}> {
  let outboxSent = 0;
  let outboxFailed = 0;
  let outboxInfraFailed = 0;

  try {
    const provider = getEmailProvider();
    const claimOwner = `hk-${process.pid}-${now.getTime()}`;

    // Step 1: recover stale claims from crashed/timed-out workers.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox
      SET status = 'pending', claim_owner = NULL, claim_expires_at = NULL, claimed_at = NULL
      -- Compared in SQL, not against a bound JS Date: a marshalled timestamptz
      -- is re-interpreted in the session TimeZone (F16-010), which would either
      -- reclaim live claims early or leave stale ones held.
      WHERE status = 'processing' AND claim_expires_at < transaction_timestamp()
    `;

    // Step 2: atomically claim a batch via FOR UPDATE SKIP LOCKED.
    // This is the concurrent-safe entry point: two workers racing to claim
    // the same row will see different rows because SKIP LOCKED skips rows
    // already locked by the other worker's transaction.
    const claimed = await unsafePrismaAdmin.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT id, to_address, to_address_encrypted, subject, body, body_encrypted, purpose, attempts, max_attempts
        FROM email_outbox
        WHERE status = 'pending'
          AND next_attempt_at <= transaction_timestamp()
        ORDER BY next_attempt_at ASC
        LIMIT ${OUTBOX_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      await tx.$executeRaw`
        UPDATE email_outbox
        SET status = 'processing',
            claim_owner = ${claimOwner},
            claim_expires_at = transaction_timestamp() + (${OUTBOX_CLAIM_TTL_SECONDS} * interval '1 second'),
            claimed_at = transaction_timestamp()
        WHERE id = ANY(${ids}::uuid[])
      `;
      return rows;
    });

    // Step 3: send each claimed row outside the DB transaction.
    for (const row of claimed) {
      try {
        const toAddress = row.to_address_encrypted
          ? (decryptField(row.to_address) ?? row.to_address)
          : row.to_address;
        const body = row.body_encrypted ? (decryptField(row.body) ?? row.body) : row.body;
        await provider.send(toAddress, row.subject, body);
        await unsafePrismaAdmin.$executeRaw`
          UPDATE email_outbox
          SET status = 'sent', sent_at = transaction_timestamp(), claim_owner = NULL
          WHERE id = ${row.id}::uuid
        `;
        outboxSent++;
      } catch (err) {
        const nextAttempts = row.attempts + 1;
        const isDead = nextAttempts >= row.max_attempts;
        const sanitizedErr = sanitizeErrorMessage(err);

        if (isDead) {
          await unsafePrismaAdmin.$executeRaw`
            UPDATE email_outbox
            SET status = 'dead',
                failed_at = NOW(),
                attempts = ${nextAttempts},
                last_error = ${sanitizedErr},
                failure_category = 'provider_error',
                claim_owner = NULL
            WHERE id = ${row.id}::uuid
          `;
        } else {
          // Exponential backoff: base * 2^attempts with bounded uniform jitter.
          // Use PostgreSQL interval arithmetic so next_attempt_at is computed
          // relative to DB clock, not Node clock.
          const backoffSeconds =
            OUTBOX_BASE_BACKOFF_SECONDS * Math.pow(2, row.attempts) +
            Math.random() * OUTBOX_JITTER_SECONDS;
          await unsafePrismaAdmin.$executeRaw`
            UPDATE email_outbox
            SET status = 'pending',
                attempts = ${nextAttempts},
                next_attempt_at = NOW() + (${backoffSeconds} * interval '1 second'),
                last_error = ${sanitizedErr},
                failure_category = 'provider_error',
                claim_owner = NULL
            WHERE id = ${row.id}::uuid
          `;
        }

        outboxFailed++;
        log.warn('housekeeping.outbox.send_failed', {
          id: row.id,
          purpose: row.purpose,
          attempts: nextAttempts,
          dead: isDead,
          err: sanitizedErr,
        });
      }
    }
  } catch (err) {
    // NOT a delivery failure. Reaching here means getEmailProvider() threw, or
    // stale-claim recovery / the claim transaction failed — the sweep did not
    // happen at all. Logged at error level and counted, so the caller can
    // report a failed job instead of a successful empty one.
    outboxInfraFailed += 1;
    log.error('housekeeping.outbox.drain_error', { err: sanitizeErrorMessage(err) });
  }

  // Step 4: sweep dead rows older than 30 days.
  let outboxSwept = 0;
  try {
    const deadCutoff = new Date(now.getTime() - 30 * ONE_DAY_MS);
    const swept = await unsafePrismaAdmin.$executeRaw`
      DELETE FROM email_outbox
      WHERE status = 'dead' AND failed_at < ${deadCutoff}
    `;
    outboxSwept = Number(swept);
  } catch (err) {
    outboxInfraFailed += 1;
    log.error('housekeeping.outbox.sweep_error', { err: sanitizeErrorMessage(err) });
  }

  return { outboxSent, outboxFailed, outboxSwept, outboxInfraFailed };
}
