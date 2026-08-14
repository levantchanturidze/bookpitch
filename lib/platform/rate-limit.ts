// -----------------------------------------------------------------------------
// Global (non-tenant) rate limiting via the platform_rate_limit table.
//
// Used by:
//   • onboard abuse protection — bucket "onboard:ip:<hmac>"
//   • onboard verify — bucket "verify:ip:<hmac>"
//   • platform reauth brute-force — bucket "reauth:<userId>" (in
//     password-reauth.ts directly via $queryRaw for the atomic upsert)
//   • TOTP verification — bucket "totp:<userId>"
//
// consumeGlobalBucket(bucket, limit, windowMs):
//   Atomically increments the counter for `bucket` in the current window.
//   Throws InvalidInputError if the counter exceeds `limit`.
//
// hashForBucket(prefix, value):
//   Returns a domain-separated HMAC-SHA256 of `value` using the rate-limit
//   HMAC key (see getRateLimitHmacKey). Callers pass IP addresses, email
//   addresses, or other PII values that must NOT be stored in plaintext.
//   The hash is a deterministic 32-hex-char prefix of the HMAC digest, which
//   is sufficient to identify the same value within the same deployment
//   without storing the raw value.
//
// extractClientIp(headers):
//   Extracts the client IP from standard reverse-proxy headers. Returns null
//   when no IP header is present (local / direct server calls).
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { unsafePrismaAdmin } from '@/lib/db';
import { InvalidInputError } from '@/lib/auth';

/**
 * Derive the HMAC key used for rate-limit bucket hashing.
 *
 * Priority:
 *   1. RATE_LIMIT_HMAC_KEY — plain 64-hex string (no key-id prefix).
 *      Set this to decouple rate-limit HMAC rotation from field encryption
 *      key rotation. Generate with: openssl rand -hex 32
 *   2. FIELD_ENCRYPTION_KEY — format "<key-id>:<64-hex>". We strip the
 *      key-id prefix and use the hex portion. Fallback for deployments that
 *      have not yet set RATE_LIMIT_HMAC_KEY.
 *
 * Throws immediately if neither is set or the hex is not 32 bytes — rate
 * limiting must never silently accept a zero-length or wrong-length key.
 *
 * BUG history: the original code called Buffer.from(FIELD_ENCRYPTION_KEY, 'hex')
 * directly. Once FIELD_ENCRYPTION_KEY adopted the "<key-id>:<hex>" format,
 * Buffer.from silently ignored the "k1:" prefix characters and produced a
 * shorter wrong key. This function fixes that by extracting the hex suffix
 * before parsing.
 */
function getRateLimitHmacKey(): Buffer {
  const dedicated = process.env.RATE_LIMIT_HMAC_KEY;
  if (dedicated) {
    const key = Buffer.from(dedicated, 'hex');
    if (key.length !== 32) {
      throw new Error('RATE_LIMIT_HMAC_KEY must be 64 hex chars (32 bytes)');
    }
    return key;
  }

  // In production, RATE_LIMIT_HMAC_KEY is required. Using FIELD_ENCRYPTION_KEY
  // as a fallback couples key rotation for two unrelated purposes and is
  // disallowed in production to enforce explicit configuration.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'RATE_LIMIT_HMAC_KEY must be set in production (set RATE_LIMIT_HMAC_KEY=<64-hex>)',
    );
  }

  // Non-production fallback: derive from the hex portion of FIELD_ENCRYPTION_KEY.
  // Format is "<key-id>:<64-hex>" — take everything after the first colon.
  const fek = process.env.FIELD_ENCRYPTION_KEY;
  if (!fek) {
    throw new Error('RATE_LIMIT_HMAC_KEY or FIELD_ENCRYPTION_KEY must be set');
  }
  const colon = fek.indexOf(':');
  if (colon < 1) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY must be "<key-id>:<64-hex>" — set RATE_LIMIT_HMAC_KEY explicitly',
    );
  }
  const hex = fek.slice(colon + 1);
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      `FIELD_ENCRYPTION_KEY hex portion must be 64 hex chars (got ${hex.length} chars) — set RATE_LIMIT_HMAC_KEY explicitly`,
    );
  }
  return key;
}

/**
 * Extract the client IP address from reverse-proxy headers.
 * Returns null when no IP header is present (e.g. direct calls in tests).
 *
 * Reads x-forwarded-for first (standard proxy chain), then x-real-ip
 * (single-IP override used by some reverse proxies). Only the first entry
 * in the x-forwarded-for chain is used — the rightmost entry is set by the
 * infrastructure and is the most trustworthy, but Vercel / Cloudflare
 * prepend the client IP as the leftmost entry; use whichever matches your
 * deployment's proxy trust policy.
 */
export function extractClientIp(headers: { get(name: string): string | null }): string | null {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? headers.get('x-real-ip') ?? null;
}

/**
 * Return a 32-hex-char HMAC-SHA256 of `value`, keyed by the rate-limit HMAC
 * key (RATE_LIMIT_HMAC_KEY, or the hex portion of FIELD_ENCRYPTION_KEY).
 *
 * The prefix provides domain separation so different callers (onboard-ip,
 * verify-ip, totp, etc.) cannot collide even with identical input values.
 *
 * Suitable as a rate-limit bucket suffix for PII values (IP address, email)
 * that must not be stored in plaintext. The 32-hex truncation is sufficient
 * for bucket identity within a deployment without storing the raw value.
 *
 * Throws if the key is not configured — callers rely on this to fail closed
 * rather than silently storing plaintext identifiers.
 */
export function hashForBucket(prefix: string, value: string): string {
  const key = getRateLimitHmacKey();
  return createHmac('sha256', key).update(`${prefix}:${value}`).digest('hex').slice(0, 32);
}

export async function consumeGlobalBucket(
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  // window_start is computed from PostgreSQL's now() so all app instances agree
  // on the active window regardless of Node/server clock divergence. The
  // expression truncates epoch-milliseconds to the nearest windowMs boundary.
  const row = await unsafePrismaAdmin.$queryRaw<Array<{ count: number }>>`
    INSERT INTO platform_rate_limit (bucket, window_start, count)
    VALUES (
      ${bucket},
      to_timestamp(
        floor(extract(epoch from now()) * 1000 / ${windowMs}::bigint) * ${windowMs}::bigint / 1000.0
      ),
      1
    )
    ON CONFLICT (bucket, window_start) DO UPDATE
      SET count = platform_rate_limit.count + 1
    RETURNING count
  `;
  const count = row[0]?.count ?? 0;
  if (count > limit) {
    throw new InvalidInputError('rate limit exceeded, try again later');
  }
}
