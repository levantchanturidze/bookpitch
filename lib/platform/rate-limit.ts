// -----------------------------------------------------------------------------
// Global (non-tenant) rate limiting via the platform_rate_limit table.
//
// Used by:
//   • onboard abuse protection — bucket "onboard:ip:<hmac>"
//   • platform reauth brute-force — bucket "reauth:<userId>" (in
//     password-reauth.ts directly via $queryRaw for the atomic upsert)
//   • TOTP verification — bucket "totp:<userId>"
//
// consumeGlobalBucket(bucket, limit, windowMs):
//   Atomically increments the counter for `bucket` in the current window.
//   Throws InvalidInputError if the counter exceeds `limit`.
//
// hashForBucket(prefix, value):
//   Returns a domain-separated HMAC-SHA256 of `value` using FIELD_ENCRYPTION_KEY
//   as the key (with HKDF domain separation via prefix). Callers pass IP addresses,
//   email addresses, or other PII values that must NOT be stored in plaintext.
//   The hash is a deterministic 32-hex-char prefix of the HMAC digest, which is
//   sufficient to identify the same value within the same deployment without
//   storing the raw value.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { unsafePrismaAdmin } from '@/lib/db';
import { InvalidInputError } from '@/lib/auth';

/**
 * Return a 32-hex-char HMAC-SHA256 of `value`, keyed by FIELD_ENCRYPTION_KEY
 * with the prefix as domain separation. Suitable as a rate-limit bucket suffix
 * for PII values (IP address, email) that must not be stored in plaintext.
 *
 * Uses `prefix:value` as the HMAC input, so different prefixes produce
 * independent key spaces even with the same raw key material.
 *
 * Throws if FIELD_ENCRYPTION_KEY is not configured — callers rely on this
 * to fail closed rather than silently storing plaintext.
 */
export function hashForBucket(prefix: string, value: string): string {
  const hexKey = process.env.FIELD_ENCRYPTION_KEY;
  if (!hexKey) throw new Error('FIELD_ENCRYPTION_KEY is not set');
  const key = Buffer.from(hexKey, 'hex');
  return createHmac('sha256', key).update(`${prefix}:${value}`).digest('hex').slice(0, 32);
}

export async function consumeGlobalBucket(
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);

  const row = await unsafePrismaAdmin.$queryRaw<Array<{ count: number }>>`
    INSERT INTO platform_rate_limit (bucket, window_start, count)
    VALUES (${bucket}, ${windowStart}, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE
      SET count = platform_rate_limit.count + 1
    RETURNING count
  `;
  const count = row[0]?.count ?? 0;
  if (count > limit) {
    throw new InvalidInputError('rate limit exceeded, try again later');
  }
}
