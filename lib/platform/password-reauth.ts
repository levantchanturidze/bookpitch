// -----------------------------------------------------------------------------
// RBAC Phase 5 — fresh-password verification for destructive platform ops.
//
// Spec §9 rule 9: destructive actions require password re-entry. The
// destination is the same primitive as break-glass step 3 (spec §7.2)
// minus 2FA (deferred per Phase 5 scope decision).
//
// API:
//   • verifyPasswordFresh(userId, password, authSessionId, purpose, opts?)
//       Argon2-verifies the password, rate-limits (5/min globally), writes
//       a PlatformReauthGrant row bound to this (user, session, purpose).
//       Atomically replaces any prior unconsumed grant for the same triple.
//       Captures app_users.session_version so the grant is automatically
//       invalidated by any event that bumps it (password change, role
//       revocation, break-glass start/end).
//
//   • requireFreshPassword(userId, authSessionId, purpose, opts?)
//       Atomically consumes exactly one unconsumed, unexpired grant whose
//       (userId, authSessionId, purpose, sessionVersion) all match.
//       Uses UPDATE...FROM...RETURNING to join the current session_version
//       in a single atomic DB operation — no TOCTOU window.
//       Throws ForbiddenError with no distinguishing detail on any failure.
//
// Session binding:
//   The authSessionId is the stable JWT claim generated at sign-in. Two
//   concurrent sessions for the same user have different authSessionIds.
//   A grant created in session A can only be consumed in session A — a
//   compromised session B cannot consume session A's freshly-verified grant.
//
// Purpose binding:
//   Each grant is created for one allowlisted action. A grant created for
//   'platform.mfa.enroll' cannot authorize 'platform.org.suspend'.
//
// Org binding:
//   Org-scoped grants (suspend, delete) include the target orgId. A grant
//   for org X cannot be consumed against org Y.
//
// Single use:
//   requireFreshPassword consumes the grant atomically (SET consumed_at =
//   now()). A second call with the same parameters finds no unconsumed grant.
//
// All operations are backed by Postgres so Vercel serverless instances
// share state.
// -----------------------------------------------------------------------------

import { verify } from '@node-rs/argon2';
import { unsafePrismaAdmin } from '@/lib/db';
import { ForbiddenError, InvalidInputError } from '@/lib/auth';
import type { ReauthPurpose } from './reauth-purpose';

const MAX_AGE_MS = 60_000;
const RATE_MAX = 5;
const RATE_WINDOW_MS = 60_000;

/**
 * Atomically increment the attempt counter. Throws InvalidInputError if the
 * count exceeds RATE_MAX within the current window.
 */
async function consumeAttemptDb(userId: string): Promise<void> {
  const now = Date.now();
  const windowMs = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const windowStart = new Date(windowMs);
  const bucket = `reauth:${userId}`;

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
 * Verify the caller's password and create a session/purpose/org-bound
 * reauthentication grant.
 *
 * The grant is single-use: requireFreshPassword atomically consumes it.
 * Any existing unconsumed grant for the same (userId, authSessionId, purpose)
 * is replaced to prevent stale grants accumulating.
 *
 * opts.maxAgeMs controls the grant TTL (default 60s). Use in tests to set a
 * shorter window and prove expiry rejection.
 */
export async function verifyPasswordFresh(
  userId: string,
  password: string,
  authSessionId: string,
  purpose: ReauthPurpose,
  opts: { throwOnBadPassword?: boolean; orgId?: string; maxAgeMs?: number } = {},
): Promise<boolean> {
  await consumeAttemptDb(userId);

  const row = await unsafePrismaAdmin.appUser.findUnique({
    where: { id: userId },
    select: { passwordHash: true, sessionVersion: true },
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

  const maxAgeMs = opts.maxAgeMs ?? MAX_AGE_MS;
  const orgId = opts.orgId ?? null;

  // expires_at is computed by the DB (now() + interval) so clock skew between
  // the application server and the database cannot cause grants to arrive
  // pre-expired. maxAgeMs is an integer we own — not user-supplied.
  // Atomically replace any existing unconsumed grant for this triple.
  // The partial unique index idx_reauth_grant_active guarantees at most one
  // unconsumed grant per (user, session, purpose) in the DB.
  await unsafePrismaAdmin.$executeRaw`
    INSERT INTO platform_reauth_grant
      (user_id, auth_session_id, purpose, org_id, expires_at, session_version)
    VALUES
      (${userId}::uuid, ${authSessionId}, ${purpose}, ${orgId}::uuid,
       now() + (${maxAgeMs} * interval '1 millisecond'), ${row.sessionVersion})
    ON CONFLICT (user_id, auth_session_id, purpose)
      WHERE consumed_at IS NULL
    DO UPDATE SET
      expires_at      = now() + (${maxAgeMs} * interval '1 millisecond'),
      session_version = EXCLUDED.session_version,
      org_id          = EXCLUDED.org_id,
      granted_at      = now()
  `;

  return true;
}

/**
 * Atomically consume one unconsumed, unexpired reauth grant that matches
 * (userId, authSessionId, purpose, orgId). The session_version binding is
 * checked inside the single UPDATE statement — no TOCTOU race.
 *
 * Throws ForbiddenError on any failure (missing, expired, consumed, version
 * drift, wrong session, wrong purpose, wrong org). The error detail is
 * intentionally generic — callers receive the same message regardless of why
 * the grant was rejected.
 */
export async function requireFreshPassword(
  userId: string,
  authSessionId: string,
  purpose: ReauthPurpose,
  opts: { orgId?: string } = {},
): Promise<void> {
  if (!authSessionId) {
    // Fail closed: a missing authSessionId means the route is not properly
    // wired to the JWT session. Deny rather than silently accept.
    throw new ForbiddenError('password re-verification required');
  }

  const orgId = opts.orgId ?? null;

  // Atomic single-use consumption.
  // The FROM app_users join embeds the session_version check in the same
  // statement: if the user's session_version has advanced since the grant
  // was issued, the WHERE predicate fails and zero rows are returned.
  // consumed_at IS NULL + expires_at > now() ensure single-use and freshness.
  const rows = await unsafePrismaAdmin.$queryRaw<Array<{ id: string }>>`
    UPDATE platform_reauth_grant g
    SET consumed_at = now()
    FROM app_users u
    WHERE g.user_id         = ${userId}::uuid
      AND g.auth_session_id = ${authSessionId}
      AND g.purpose         = ${purpose}
      AND (g.org_id = ${orgId}::uuid OR (${orgId}::uuid IS NULL AND g.org_id IS NULL))
      AND g.consumed_at     IS NULL
      AND g.expires_at      > now()
      AND g.session_version = u.session_version
      AND u.id              = ${userId}::uuid
      AND u.status          = 'active'
    RETURNING g.id
  `;

  if (rows.length === 0) {
    throw new ForbiddenError('password re-verification required');
  }
}

/**
 * Verify a password directly — rate-limited but does NOT create a reauth
 * grant. Use for flows where authentication and the action happen in the same
 * request (e.g. break-glass activation, which supplies password + TOTP +
 * reason + ticketId in a single POST). Routes that use the two-step
 * pattern (POST /api/platform/reauth → POST /api/platform/action) should use
 * verifyPasswordFresh + requireFreshPassword instead.
 */
export async function verifyPasswordDirect(
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
  return true;
}

/**
 * Test-only helper — flush the rate-limit and grant rows so consecutive
 * tests don't share state across the DB.
 */
export async function __clearPasswordReauthCache(): Promise<void> {
  await unsafePrismaAdmin.platformRateLimit
    .deleteMany({
      where: { bucket: { startsWith: 'reauth:' } },
    })
    .catch(() => {});
  await unsafePrismaAdmin.platformReauthGrant.deleteMany({}).catch(() => {});
}
