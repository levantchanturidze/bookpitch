// -----------------------------------------------------------------------------
// RBAC Phase 5 — fresh-password verification for destructive platform ops.
//
// Spec §9 rule 9: destructive actions require password re-entry. The
// destination is the same primitive as break-glass step 3 (spec §7.2)
// minus the 2FA (deferred per Phase 5 scope decision — see the plan's
// "Not in scope" section).
//
// API:
//   • verifyPasswordFresh(userId, password) — argon2 compare + rate limit +
//     writes a PlatformReauthGrant row (expires MAX_AGE_MS from now).
//     Rate-limited via the platform_rate_limit table — 5 attempts per
//     rolling minute, globally consistent across Vercel instances.
//   • requireFreshPassword(userId) — throws ForbiddenError if no valid
//     grant row exists for the user. Called by guards on org-suspend,
//     org-soft-delete, break-glass activation, and toggle mutations.
//
// Both operations are backed by Postgres so Vercel serverless instances
// share state. An in-memory L1 cache in requireFreshPassword avoids the
// round-trip on the common case (same instance that just did the reauth).
// -----------------------------------------------------------------------------

import { verify } from '@node-rs/argon2';
import { unsafePrismaAdmin } from '@/lib/db';
import { ForbiddenError, InvalidInputError } from '@/lib/auth';

const MAX_AGE_MS = 60_000;
const RATE_MAX = 5;
const RATE_WINDOW_MS = 60_000;

// L1 in-memory cache — short-circuits the DB read when the grant was
// issued on this instance within the freshness window. Evicted on window
// expiry. Not a correctness requirement: requireFreshPassword always
// falls back to the DB if the cache says "unknown".
const l1Cache = new Map<string, { expiresAt: number }>();

function l1Set(userId: string, expiresAt: number): void {
  l1Cache.set(userId, { expiresAt });
}

function l1Check(userId: string): boolean {
  const hit = l1Cache.get(userId);
  if (!hit) return false;
  if (Date.now() >= hit.expiresAt) {
    l1Cache.delete(userId);
    return false;
  }
  return true;
}

/**
 * Atomically increment the attempt counter for `userId` in the
 * platform_rate_limit table. Throws InvalidInputError if the count
 * exceeds RATE_MAX within the current window.
 *
 * Uses a fixed 60s window (truncated to the minute). The window_start
 * epoch-truncation is done by the app rather than a DB function so the
 * table structure stays simple.
 */
async function consumeAttemptDb(userId: string): Promise<void> {
  const now = Date.now();
  const windowMs = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const windowStart = new Date(windowMs);
  const bucket = `reauth:${userId}`;

  // Upsert: increment count; read back the final value atomically.
  const row = await unsafePrismaAdmin.$queryRaw<Array<{ count: number }>>`
    INSERT INTO platform_rate_limit (bucket, window_start, count)
    VALUES (${bucket}, ${windowStart}, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE
      SET count = platform_rate_limit.count + 1
    RETURNING count
  `;
  const count = row[0]?.count ?? 0;
  if (count > RATE_MAX) {
    throw new InvalidInputError('too many password attempts, wait a minute');
  }
}

/**
 * Verify the caller's password. On success, writes a PlatformReauthGrant
 * row (or replaces an existing one) and sets the L1 cache. Rate-limited
 * at RATE_MAX attempts per rolling minute via platform_rate_limit table.
 *
 * `throwOnBadPassword` = true surfaces wrong passwords as
 * InvalidInputError (400) rather than returning false — used by endpoints
 * where the caller already filled in the password field (e.g. break-glass).
 */
export async function verifyPasswordFresh(
  userId: string,
  password: string,
  opts: { throwOnBadPassword?: boolean } = {},
): Promise<boolean> {
  await consumeAttemptDb(userId);

  const row = await unsafePrismaAdmin.appUser.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!row?.passwordHash) {
    if (opts.throwOnBadPassword) throw new InvalidInputError('password verification failed');
    return false;
  }

  const ok = await verify(row.passwordHash, password);
  if (!ok) {
    if (opts.throwOnBadPassword) throw new InvalidInputError('password verification failed');
    return false;
  }

  const expiresAt = new Date(Date.now() + MAX_AGE_MS);
  await unsafePrismaAdmin.platformReauthGrant.upsert({
    where: { userId },
    create: { userId, expiresAt },
    update: { grantedAt: new Date(), expiresAt },
  });
  l1Set(userId, expiresAt.getTime());
  return true;
}

/**
 * Throws ForbiddenError if `userId` does not have a valid (non-expired)
 * PlatformReauthGrant. Checks L1 first; falls back to Postgres.
 *
 * Called at the top of destructive route handlers (spec §9 rule 9). The
 * client is expected to have POST /api/platform/reauth within the last
 * minute.
 */
export async function requireFreshPassword(
  userId: string,
  maxAgeMs = MAX_AGE_MS,
): Promise<void> {
  // L1 fast path — only when caller uses the default window. A tighter
  // maxAgeMs (e.g. -1 in tests) must go to the DB so the age check runs.
  if (maxAgeMs >= MAX_AGE_MS && l1Check(userId)) return;

  // DB fallback — visible across all instances.
  const grant = await unsafePrismaAdmin.platformReauthGrant.findUnique({
    where: { userId },
    select: { expiresAt: true },
  });
  if (!grant || grant.expiresAt.getTime() < Date.now()) {
    throw new ForbiddenError('password re-verification required');
  }
  // Respect a tighter maxAgeMs window (e.g. in tests).
  const grantAge = Date.now() - (grant.expiresAt.getTime() - MAX_AGE_MS);
  if (grantAge > maxAgeMs) {
    throw new ForbiddenError('password re-verification required');
  }
  // Populate L1 so subsequent calls on this instance are cache hits.
  l1Set(userId, grant.expiresAt.getTime());
}

/**
 * Test-only helper — flush the L1 cache AND the DB rate-limit / grant
 * rows so consecutive tests don't share state across the DB.
 */
export async function __clearPasswordReauthCache(): Promise<void> {
  l1Cache.clear();
  await unsafePrismaAdmin.platformRateLimit.deleteMany({
    where: { bucket: { startsWith: 'reauth:' } },
  }).catch(() => {});
  await unsafePrismaAdmin.platformReauthGrant.deleteMany({}).catch(() => {});
}
