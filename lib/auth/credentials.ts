import { verify } from '@node-rs/argon2';
import { withoutRls } from '@/lib/db';
import { log } from '@/lib/logger';

// -----------------------------------------------------------------------------
// F-05: extracted credential-check logic so an integration test can hit the
// real path end to end (real DB, real argon2, real role load). Auth.js's
// authorize() callback in auth.ts is a thin wrapper around this. See
// tests/credentials.test.ts.
//
// Returns a shape suitable for return from Auth.js's authorize() (a plain
// object → Auth.js builds the JWT from it). Returns null for any failure —
// no distinction between "unknown email", "bad password", "no membership",
// "account deleted" (spec: don't leak which one). Callers must not surface
// the reason to end-users.
// -----------------------------------------------------------------------------

export type CredentialInput = {
  email: string;
  password: string;
  requestedOrgId?: string | null;
};

export type CredentialResult = {
  id: string;
  email: string;
  name: string | undefined;
  activeOrganizationId: string | null;
  membershipId: string | null;
  platformRoleId: string | null;
  roleKey: string | null;
  sessionVersion: number;
};

/**
 * Verify a user's credentials against the DB. Returns the shape Auth.js's
 * authorize() should return: the user + org context, or null on any
 * failure. Never throws for expected failure modes — auth returns null and
 * Auth.js maps that to an error=CredentialsSignin redirect.
 *
 * Failure modes that all return null (no distinction leaked):
 *   • email not registered
 *   • account has no password_hash (SSO-only user, or never set)
 *   • account status != 'active' (deleted, locked, suspended)
 *   • wrong password
 *   • no active membership AND no platform role (broken account)
 *   • requested orgId doesn't correspond to an active membership
 *
 * Success returns the seven-field object below. Platform-only users have
 * activeOrganizationId=null and membershipId=null (spec §4.1 — they operate
 * cross-tenant via impersonation/break-glass).
 */
export async function validateCredentials(
  input: CredentialInput,
): Promise<CredentialResult | null> {
  const { email, password } = input;
  const requestedOrgId = input.requestedOrgId ?? null;

  const user = await withoutRls(async (tx) => {
    return tx.appUser.findUnique({
      where: { email },
      include: {
        memberships: requestedOrgId
          ? {
              where: { organizationId: requestedOrgId, status: 'active' },
              take: 1,
              include: { roleRef: { select: { key: true } } },
            }
          : {
              orderBy: { createdAt: 'asc' },
              take: 1,
              where: { status: 'active' },
              include: { roleRef: { select: { key: true } } },
            },
      },
    });
  });

  if (!user) {
    log.warn('auth.credentials.fail', { reason: 'user_not_found' });
    return null;
  }
  if (!user.passwordHash) {
    log.warn('auth.credentials.fail', {
      reason: 'no_password_hash',
      platformRoleId: user.platformRoleId,
      status: user.status,
    });
    return null;
  }
  if (user.status !== 'active') {
    log.warn('auth.credentials.fail', { reason: 'not_active', status: user.status });
    return null;
  }

  const hasMembership = user.memberships.length > 0;
  const isPlatformUser = user.platformRoleId != null;
  if (!hasMembership && !isPlatformUser) {
    log.warn('auth.credentials.fail', { reason: 'no_membership_no_platform_role' });
    return null;
  }

  const ok = await verify(user.passwordHash, password);
  if (!ok) {
    log.warn('auth.credentials.fail', { reason: 'wrong_password' });
    return null;
  }

  const membership = hasMembership ? user.memberships[0] : null;

  return {
    id: user.id,
    email: user.email,
    name: user.fullName ?? undefined,
    activeOrganizationId: membership?.organizationId ?? null,
    membershipId: membership?.id ?? null,
    platformRoleId: user.platformRoleId,
    roleKey: membership?.roleRef?.key ?? null,
    sessionVersion: user.sessionVersion,
  };
}
