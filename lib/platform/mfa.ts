// -----------------------------------------------------------------------------
// TOTP MFA for SUPER_ADMIN break-glass (spec §7.2 rule 3).
//
// Enrollment:
//   1. generateTotpEnrollment(userId) — creates a new secret, encrypts it
//      with FIELD_ENCRYPTION_KEY, saves as mfa_totp (pending — not yet
//      confirmed), returns the secret and otpauth URI for QR rendering.
//   2. confirmTotpEnrollment(userId, code) — verifies the first code and
//      sets mfa_enabled=true; no-op if already enrolled with the same secret.
//
// Verification (called from startBreakGlass):
//   verifyTotp(userId, code) — decrypts the stored secret, runs TOTP
//   verify, checks replay via mfa_last_totp_window, updates the window
//   counter on success. Throws InvalidInputError on any failure.
//
// The secret is stored encrypted with AES-256-GCM (same key as allergies /
// clinical_notes). The plaintext secret never leaves this module except
// during enrollment (returned to the SUPER_ADMIN for QR rendering).
// -----------------------------------------------------------------------------

import { randomBytes, createHash } from 'node:crypto';
import { generateSecret, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';
import { verify } from '@otplib/totp';
import { encryptField, decryptField } from '@/lib/crypto';
import { unsafePrismaAdmin } from '@/lib/db';
import { InvalidInputError } from '@/lib/auth';
import { consumeGlobalBucket } from './rate-limit';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import { getEmailProvider } from '@/lib/messaging';

// Shared plugin set for all TOTP operations.
const TOTP_PLUGINS = {
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
};

// TOTP rate limit: 5 code attempts per 5-minute window per user.
const TOTP_RATE_LIMIT = 5;
const TOTP_RATE_WINDOW_MS = 5 * 60 * 1000;

// Recovery code config.
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_BYTES = 10; // 80-bit entropy per code
const RECOVERY_RATE_LIMIT = 5;
const RECOVERY_RATE_WINDOW_MS = 5 * 60 * 1000;

export type TotpEnrollmentResult = {
  secret: string;
  otpauthUri: string;
};

/**
 * Generate a new TOTP secret, encrypt it, and write it to the DB.
 * Returns the plaintext secret and otpauth URI for QR code rendering.
 *
 * Initial enrollment (mfaEnabled=false):
 *   Writes directly to mfaTotp. mfaEnabled stays false until
 *   confirmTotpEnrollment sets it to true.
 *
 * Re-enrollment (mfaEnabled=true):
 *   Writes to mfaTotpPending only — mfaTotp is NOT touched.
 *   This preserves the active break-glass path (verifyTotp reads mfaTotp)
 *   until the new secret is confirmed. confirmTotpEnrollment then promotes
 *   mfaTotpPending → mfaTotp and clears the pending column.
 */
export async function generateTotpEnrollment(userId: string): Promise<TotpEnrollmentResult> {
  const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, mfaEnabled: true },
  });

  const secret = generateSecret();
  const encryptedSecret = encryptField(secret);

  if (user.mfaEnabled) {
    // Re-enrollment: write to pending only. Active secret stays intact.
    await unsafePrismaAdmin.appUser.update({
      where: { id: userId },
      data: { mfaTotpPending: encryptedSecret, mfaTotpPendingCreatedAt: new Date() },
    });
  } else {
    // Initial enrollment: write directly to mfaTotp; mfaEnabled stays false.
    await unsafePrismaAdmin.appUser.update({
      where: { id: userId },
      data: { mfaTotp: encryptedSecret, mfaEnabled: false },
    });
  }

  const issuer = 'Bookpitch';
  const otpauthUri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user.email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

  return { secret, otpauthUri };
}

/**
 * Confirm a TOTP enrollment by verifying the first code.
 *
 * Initial enrollment (mfaEnabled=false): verifies against mfaTotp, sets
 * mfaEnabled=true.
 *
 * Re-enrollment (mfaEnabled=true, mfaTotpPending set): verifies against
 * mfaTotpPending, promotes it to mfaTotp, and clears mfaTotpPending.
 * The old mfaTotp remains active until this point so break-glass is unaffected.
 *
 * Atomic: the secret promotion, replay-window advance, session-version bump,
 * reauth-grant invalidation, and audit write all succeed or all roll back.
 * The TOTP algorithm runs outside the transaction (CPU-only); the conditional
 * UPDATE then commits the result only if no concurrent call already consumed
 * the same time-step.
 */
export async function confirmTotpEnrollment(userId: string, code: string): Promise<void> {
  await consumeGlobalBucket(`totp:${userId}`, TOTP_RATE_LIMIT, TOTP_RATE_WINDOW_MS);

  const user = await unsafePrismaAdmin.appUser.findUnique({
    where: { id: userId },
    select: { mfaTotp: true, mfaTotpPending: true, mfaEnabled: true },
  });

  // Determine which column holds the candidate secret.
  const isReEnrollment = user?.mfaEnabled && !!user?.mfaTotpPending;
  const candidateEncrypted = isReEnrollment ? user!.mfaTotpPending! : user?.mfaTotp;

  if (!candidateEncrypted) {
    throw new InvalidInputError('MFA enrollment not started — call enroll first');
  }

  const secret = decryptField(candidateEncrypted);
  if (!secret) throw new InvalidInputError('MFA secret is corrupt');

  const result = await verify({ ...TOTP_PLUGINS, token: code.trim(), secret });
  if (!result.valid) {
    throw new InvalidInputError('invalid TOTP code');
  }

  const totpWindow = BigInt(result.timeStep);

  // Atomic transaction: promote secret + advance replay fence + bump session
  // version + invalidate grants + write audit. The conditional UPDATE ensures
  // two concurrent confirmations with the same time-step both cannot succeed.
  await unsafePrismaAdmin.$transaction(async (tx) => {
    let rowsUpdated: number | bigint;
    if (isReEnrollment) {
      // Promote mfa_totp_pending → mfa_totp only if pending still equals what
      // we verified against. A concurrent re-enrollment overwriting pending
      // would cause 0 rows here, which is the correct failure mode.
      rowsUpdated = await tx.$executeRaw`
        UPDATE app_users
        SET mfa_totp = ${candidateEncrypted},
            mfa_totp_pending = NULL,
            mfa_totp_pending_created_at = NULL,
            mfa_enabled = true,
            mfa_last_totp_window = ${totpWindow},
            session_version = session_version + 1
        WHERE id = ${userId}::uuid
          AND mfa_totp_pending = ${candidateEncrypted}
          AND (mfa_last_totp_window IS NULL OR mfa_last_totp_window < ${totpWindow})
      `;
    } else {
      rowsUpdated = await tx.$executeRaw`
        UPDATE app_users
        SET mfa_enabled = true,
            mfa_last_totp_window = ${totpWindow},
            session_version = session_version + 1
        WHERE id = ${userId}::uuid
          AND (mfa_last_totp_window IS NULL OR mfa_last_totp_window < ${totpWindow})
      `;
    }

    if (Number(rowsUpdated) === 0) {
      throw new InvalidInputError('TOTP code has already been used — wait for the next code');
    }

    // Invalidate any outstanding reauth grants so sessions tied to pre-MFA
    // state cannot be used to access MFA-gated operations.
    await tx.platformReauthGrant.deleteMany({ where: { userId } });

    await tx.auditLog.create({
      data: {
        organizationId: null,
        actorUserId: userId,
        action: isReEnrollment ? 'mfa.totp.re_enrolled' : 'mfa.totp.enrolled',
        entity: 'staff',
      },
    });
  });
}

/**
 * Rate-limit + verify a TOTP code WITHOUT advancing the replay fence.
 * Returns the time-step bigint that the caller must atomically lock inside
 * a DB transaction. Throws on invalid code so the transaction is never
 * entered with bad credentials.
 *
 * Used by startBreakGlass to ensure the fence-advance is inside the same
 * atomic transaction as session creation.
 */
export async function preCheckTotp(userId: string, code: string): Promise<bigint> {
  await consumeGlobalBucket(`totp:${userId}`, TOTP_RATE_LIMIT, TOTP_RATE_WINDOW_MS);

  const user = await unsafePrismaAdmin.appUser.findUnique({
    where: { id: userId },
    select: { mfaTotp: true, mfaEnabled: true },
  });

  if (!user?.mfaTotp || !user.mfaEnabled) {
    throw new InvalidInputError(
      'MFA not enrolled — enroll via POST /api/platform/mfa/enroll before activating break-glass',
    );
  }

  const secret = decryptField(user.mfaTotp);
  if (!secret) throw new InvalidInputError('MFA secret is corrupt — re-enroll');

  const result = await verify({ ...TOTP_PLUGINS, token: code.trim(), secret });
  if (!result.valid) {
    throw new InvalidInputError('invalid or expired TOTP code');
  }

  return BigInt(result.timeStep);
}

/**
 * Rate-limit and hash a recovery code WITHOUT marking it as used.
 * Returns the code hash that the caller must atomically mark-used inside
 * a DB transaction. Throws on format errors so the transaction is never
 * entered with a clearly invalid code.
 *
 * Used by startBreakGlass to ensure the mark-used is inside the same
 * atomic transaction as session creation.
 */
export async function preCheckRecoveryCode(userId: string, code: string): Promise<string> {
  await consumeGlobalBucket(`recovery:${userId}`, RECOVERY_RATE_LIMIT, RECOVERY_RATE_WINDOW_MS);

  const normalized = normalizeRecoveryCode(code);
  if (normalized.length < 10) throw new InvalidInputError('invalid recovery code');

  return hashRecoveryCode(normalized);
}

/**
 * Verify a TOTP code for break-glass activation. Called from
 * startBreakGlass after password verification.
 *
 * Throws ForbiddenError / InvalidInputError on any failure so the
 * caller cannot distinguish enrolled-but-wrong from not-enrolled
 * from rate-limited — all become the same 400/403 at the route level.
 */
export async function verifyTotp(userId: string, code: string): Promise<void> {
  await consumeGlobalBucket(`totp:${userId}`, TOTP_RATE_LIMIT, TOTP_RATE_WINDOW_MS);

  const user = await unsafePrismaAdmin.appUser.findUnique({
    where: { id: userId },
    select: { mfaTotp: true, mfaEnabled: true, mfaLastTotpWindow: true },
  });

  if (!user?.mfaTotp || !user.mfaEnabled) {
    throw new InvalidInputError(
      'MFA not enrolled — enroll via POST /api/platform/mfa/enroll before activating break-glass',
    );
  }

  const secret = decryptField(user.mfaTotp);
  if (!secret) throw new InvalidInputError('MFA secret is corrupt — re-enroll');

  const result = await verify({ ...TOTP_PLUGINS, token: code.trim(), secret });
  if (!result.valid) {
    throw new InvalidInputError('invalid or expired TOTP code');
  }

  // Replay protection — atomic conditional update.
  //
  // The read→check→update pattern is a TOCTOU race: two concurrent requests
  // with the same code can both pass the check then both write. Instead, issue
  // a single UPDATE that only succeeds when the DB row has NOT yet advanced to
  // this window. If 0 rows are affected another request already consumed it.
  const thisWindow = BigInt(result.timeStep);
  const updated = await unsafePrismaAdmin.$executeRaw`
    UPDATE app_users
    SET mfa_last_totp_window = ${thisWindow}
    WHERE id = ${userId}::uuid
      AND (mfa_last_totp_window IS NULL OR mfa_last_totp_window < ${thisWindow})
  `;
  if (updated === 0) {
    throw new InvalidInputError('TOTP code has already been used — wait for the next code');
  }
}

// ── Recovery codes ────────────────────────────────────────────────────────────
//
// Single-use backup codes for when the authenticator app is unavailable.
// Displayed once (never again); stored only as SHA-256 hashes (codes are
// cryptographically random, so SHA-256 is brute-force-infeasible).
//
// Flow:
//   1. generateRecoveryCodes(userId)  — requires MFA enrolled.
//   2. User stores codes securely (shown once).
//   3. startBreakGlassWithRecovery() or consumeRecoveryCode() — atomic.

function hashRecoveryCode(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function formatRecoveryCode(bytes: Buffer): string {
  // Produce a human-readable code: XXXXXX-XXXXXX-XXXXXX (3 groups of 6 hex chars)
  const hex = bytes.toString('hex').toUpperCase(); // 20 chars
  return `${hex.slice(0, 5)}-${hex.slice(5, 10)}-${hex.slice(10, 15)}-${hex.slice(15)}`;
}

function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[-\s]/g, '');
}

export type GenerateRecoveryCodesResult = {
  codes: string[]; // Plaintext codes — shown once; never stored.
};

/** Count of unused recovery codes remaining for `userId`. */
export async function getRemainingRecoveryCodeCount(userId: string): Promise<number> {
  return unsafePrismaAdmin.appUserRecoveryCode.count({
    where: { userId, usedAt: null },
  });
}

/**
 * Generate a fresh set of recovery codes for `userId`. Requires MFA to be
 * enrolled. Deletes all existing codes (including used ones) and creates
 * RECOVERY_CODE_COUNT new ones. Returns plaintexts — display once and discard.
 */
export async function generateRecoveryCodes(userId: string): Promise<GenerateRecoveryCodesResult> {
  const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { id: userId },
    select: { mfaEnabled: true },
  });
  if (!user.mfaEnabled) {
    throw new InvalidInputError('MFA must be enrolled before generating recovery codes');
  }

  // Generate all codes before entering the transaction — randomBytes is not DB-dependent.
  const codes: string[] = [];
  const records: { userId: string; codeHash: string }[] = [];

  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const formatted = formatRecoveryCode(randomBytes(RECOVERY_CODE_BYTES));
    const normalized = normalizeRecoveryCode(formatted);
    records.push({ userId, codeHash: hashRecoveryCode(normalized) });
    codes.push(formatted);
  }

  // Atomic: delete all existing codes AND insert new ones in one transaction.
  // Without this, a crash between deleteMany and createMany leaves the user with zero codes.
  await unsafePrismaAdmin.$transaction(async (tx) => {
    await tx.appUserRecoveryCode.deleteMany({ where: { userId } });
    await tx.appUserRecoveryCode.createMany({ data: records });
  });

  log.info('platform.mfa.recovery_codes.generated', { userId, count: codes.length });

  return { codes };
}

/**
 * Atomically consume one recovery code for `userId`. Throws InvalidInputError
 * on invalid, used, or rate-limited code. On success: bumps sessionVersion,
 * invalidates outstanding reauth grant, and writes an audit entry.
 *
 * DOES NOT disable MFA — the user retains break-glass access via TOTP.
 * After consumption, the user should re-generate codes or re-enroll TOTP.
 */
export async function consumeRecoveryCode(userId: string, code: string): Promise<void> {
  await consumeGlobalBucket(`recovery:${userId}`, RECOVERY_RATE_LIMIT, RECOVERY_RATE_WINDOW_MS);

  const normalized = normalizeRecoveryCode(code);
  if (normalized.length < 10) {
    throw new InvalidInputError('invalid recovery code');
  }

  const codeHash = hashRecoveryCode(normalized);

  // Atomic transaction: mark-used, sessionVersion bump, reauth grant delete,
  // audit log, and security alert outbox INSERT all succeed or all roll back.
  // The alert is in the outbox (not a direct send) so a mail provider failure
  // cannot roll back the consumed code — the durable worker retries delivery.
  const alertIdempotencyKey = await unsafePrismaAdmin.$transaction(async (tx) => {
    // Atomic: mark used only if this code exists and is unused.
    const updated = await tx.$executeRaw`
      UPDATE app_user_recovery_codes
      SET used_at = now()
      WHERE user_id = ${userId}::uuid
        AND code_hash = ${codeHash}
        AND used_at IS NULL
    `;

    if (updated === 0) {
      throw new InvalidInputError('invalid or already-used recovery code');
    }

    // Bump sessionVersion: invalidates any cached sessions and reauth grants.
    await tx.appUser.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
    });

    // Invalidate the reauth grant so the attacker's window closes.
    await tx.platformReauthGrant.deleteMany({ where: { userId } });

    await tx.auditLog.create({
      data: {
        organizationId: null,
        actorUserId: userId,
        action: 'mfa.recovery_code.consumed',
        entity: 'staff',
      },
    });

    const user = await tx.appUser.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const alertTo = process.env.SECURITY_ALERT_EMAIL ?? user?.email ?? '';

    if (alertTo) {
      const alertPlain =
        `A break-glass MFA recovery code was consumed.\n\n` +
        `If this was not you, your account may be compromised. ` +
        `Reset your password immediately.`;
      const alertEncrypted = encryptField(alertPlain) ?? alertPlain;
      const bodyEncrypted = alertEncrypted !== alertPlain;
      const idempotencyKey = `recovery_alert:${userId}:${codeHash.slice(0, 16)}`;
      await tx.emailOutbox.create({
        data: {
          idempotencyKey,
          toAddress: alertTo,
          subject: '[Bookpitch] MFA recovery code used',
          body: alertEncrypted,
          bodyEncrypted,
          purpose: 'mfa.recovery_alert',
        },
      });
      return idempotencyKey;
    }

    return null;
  });

  // Immediate drain — best-effort, outside the DB transaction.
  if (alertIdempotencyKey) {
    try {
      type ClaimedRow = {
        id: string;
        to_address: string;
        subject: string;
        body: string;
        body_encrypted: boolean;
      };
      const [claimed] = await unsafePrismaAdmin.$queryRaw<ClaimedRow[]>`
        UPDATE email_outbox
        SET status = 'processing',
            claim_owner = 'recovery_immediate',
            claim_expires_at = now() + interval '120 seconds',
            claimed_at = now()
        WHERE idempotency_key = ${alertIdempotencyKey} AND status = 'pending'
        RETURNING id, to_address, subject, body, body_encrypted
      `;
      if (claimed) {
        const body = claimed.body_encrypted
          ? (decryptField(claimed.body) ?? claimed.body)
          : claimed.body;
        const provider = getEmailProvider();
        await provider.send(claimed.to_address, claimed.subject, body);
        await unsafePrismaAdmin.$executeRaw`
          UPDATE email_outbox
          SET status = 'sent', sent_at = now(), claim_owner = NULL
          WHERE id = ${claimed.id}::uuid
        `;
      }
    } catch (err) {
      log.warn('platform.mfa.recovery_alert_drain_failed', { err: sanitizeErrorMessage(err) });
    }
  }
}
