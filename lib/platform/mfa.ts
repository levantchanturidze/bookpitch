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

import { generateSecret, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';
import { verify } from '@otplib/totp';
import { encryptField, decryptField } from '@/lib/crypto';
import { unsafePrismaAdmin } from '@/lib/db';
import { InvalidInputError } from '@/lib/auth';
import { consumeGlobalBucket } from './rate-limit';

// Shared plugin set for all TOTP operations.
const TOTP_PLUGINS = {
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
};

// TOTP rate limit: 5 code attempts per 5-minute window per user.
const TOTP_RATE_LIMIT = 5;
const TOTP_RATE_WINDOW_MS = 5 * 60 * 1000;

export type TotpEnrollmentResult = {
  secret: string;
  otpauthUri: string;
};

/**
 * Generate a new TOTP secret, encrypt it, and write it to the DB
 * (mfa_enabled stays false until confirmTotpEnrollment succeeds).
 * Returns the plaintext secret and otpauth URI for QR code rendering.
 *
 * Calling this again before confirmation replaces the pending secret.
 */
export async function generateTotpEnrollment(userId: string): Promise<TotpEnrollmentResult> {
  const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true },
  });

  const secret = generateSecret();
  const encryptedSecret = encryptField(secret);

  // Write the pending secret. mfa_enabled stays false until confirmed.
  await unsafePrismaAdmin.appUser.update({
    where: { id: userId },
    data: { mfaTotp: encryptedSecret, mfaEnabled: false },
  });

  const issuer = 'Bookpitch';
  const otpauthUri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user.email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

  return { secret, otpauthUri };
}

/**
 * Confirm a TOTP enrollment by verifying the first code.
 * Sets mfa_enabled=true on the user row.
 */
export async function confirmTotpEnrollment(userId: string, code: string): Promise<void> {
  await consumeGlobalBucket(`totp:${userId}`, TOTP_RATE_LIMIT, TOTP_RATE_WINDOW_MS);

  const user = await unsafePrismaAdmin.appUser.findUnique({
    where: { id: userId },
    select: { mfaTotp: true, mfaEnabled: true },
  });
  if (!user?.mfaTotp) {
    throw new InvalidInputError('MFA enrollment not started — call enroll first');
  }

  const secret = decryptField(user.mfaTotp);
  if (!secret) throw new InvalidInputError('MFA secret is corrupt');

  const result = await verify({ ...TOTP_PLUGINS, token: code.trim(), secret });
  if (!result.valid) {
    throw new InvalidInputError('invalid TOTP code');
  }

  await unsafePrismaAdmin.appUser.update({
    where: { id: userId },
    data: { mfaEnabled: true, mfaLastTotpWindow: BigInt(result.timeStep) },
  });
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
    throw new InvalidInputError('MFA not enrolled — enroll via POST /api/platform/mfa/enroll before activating break-glass');
  }

  const secret = decryptField(user.mfaTotp);
  if (!secret) throw new InvalidInputError('MFA secret is corrupt — re-enroll');

  const result = await verify({ ...TOTP_PLUGINS, token: code.trim(), secret });
  if (!result.valid) {
    throw new InvalidInputError('invalid or expired TOTP code');
  }

  // Replay protection: reject if this 30s window was already used.
  const thisWindow = BigInt(result.timeStep);
  if (user.mfaLastTotpWindow !== null && user.mfaLastTotpWindow >= thisWindow) {
    throw new InvalidInputError('TOTP code has already been used — wait for the next code');
  }

  // Advance the last-used window.
  await unsafePrismaAdmin.appUser.update({
    where: { id: userId },
    data: { mfaLastTotpWindow: thisWindow },
  });
}
