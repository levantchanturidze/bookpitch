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
//     mark the userId "fresh" for `MAX_AGE_MS`. Returns true on success,
//     false on wrong password. Rate-limited via a per-user token bucket
//     (in-memory) — 5 attempts / rolling minute.
//   • requireFreshPassword(userId) — throws ForbiddenError if the user
//     hasn't verified within the freshness window. Called by guards on
//     org-suspend, org-soft-delete, break-glass activation.
//
// TODO(Phase 5 v2): when TOTP infrastructure lands (otplib + secret
// column on app_users), extend verifyPasswordFresh with an optional
// `totpCode: string` parameter and require it when mfa_enabled=true.
// The freshness marker stays; only the verification step gains a second
// factor. Contract stays backwards compatible.
// -----------------------------------------------------------------------------

import { verify } from '@node-rs/argon2';
import { unsafePrismaAdmin } from '@/lib/db';
import { ForbiddenError, InvalidInputError } from '@/lib/auth';

const MAX_AGE_MS = 60_000;               // spec §7.2 rule 3 — verified at moment of use
const RATE_MAX = 5;                      // 5 attempts
const RATE_WINDOW_MS = 60_000;           // per rolling minute

type FreshEntry = { at: number };
const freshness = new Map<string, FreshEntry>();

type Attempt = { at: number; count: number };
const rateBucket = new Map<string, Attempt>();

function consumeAttempt(userId: string): void {
  const now = Date.now();
  const hit = rateBucket.get(userId);
  if (!hit || now - hit.at > RATE_WINDOW_MS) {
    rateBucket.set(userId, { at: now, count: 1 });
    return;
  }
  hit.count += 1;
  if (hit.count > RATE_MAX) {
    // The rate-limit window is a bit longer than a normal user would need
    // between two prompts; hitting it means someone is bruteforcing.
    throw new InvalidInputError('too many password attempts, wait a minute');
  }
}

/**
 * Verify the caller's password. On success, marks the userId as
 * "password-verified" for MAX_AGE_MS. Rate-limited at 5 attempts per
 * rolling minute per userId. `throwOnBadPassword` = true makes wrong
 * passwords surface as InvalidInputError (400) rather than a silent
 * false — used by endpoints that expect the caller to have entered a
 * password already (e.g. break-glass activation).
 */
export async function verifyPasswordFresh(
  userId: string,
  password: string,
  opts: { throwOnBadPassword?: boolean } = {},
): Promise<boolean> {
  consumeAttempt(userId);

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

  freshness.set(userId, { at: Date.now() });
  return true;
}

/**
 * Throws ForbiddenError if `userId` hasn't verified their password
 * within MAX_AGE_MS. Called at the top of destructive route handlers
 * (spec §9 rule 9). The client is expected to have prompted the caller
 * to enter their password and posted to `POST /api/platform/reauth`
 * within the last minute.
 */
export function requireFreshPassword(userId: string, maxAgeMs = MAX_AGE_MS): void {
  const hit = freshness.get(userId);
  const now = Date.now();
  if (!hit || now - hit.at > maxAgeMs) {
    throw new ForbiddenError('password re-verification required');
  }
}

/** Test-only helper — flush the freshness cache between tests. */
export function __clearPasswordReauthCache(): void {
  freshness.clear();
  rateBucket.clear();
}
