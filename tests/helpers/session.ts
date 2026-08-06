// -----------------------------------------------------------------------------
// Test helper: build a Phase 4-shaped JWT mock for the `auth()` mock.
//
// Phase 3 added activeOrganizationId + membershipId + platformRoleId to the
// JWT. Phase 4 removed the legacy organizationId + role aliases. Tests that
// mock `auth()` must return this exact shape or requireAuthContext() rejects
// with UnauthenticatedError (missing membership).
//
// Phase 5 added authSessionId — a stable random identifier generated at
// sign-in. Tests that exercise the reauth grant path must supply a consistent
// authSessionId to both the JWT mock and the verifyPasswordFresh call.
//
// Usage:
//   const SESSION = 'test-session-id';
//   authMock.mockResolvedValue(await mockJwt(userId, orgId, SESSION));
//   await verifyPasswordFresh(userId, 'pass', SESSION, 'platform.mfa.enroll');
// -----------------------------------------------------------------------------

import { unsafePrismaAdmin } from '@/lib/db';

export async function mockJwt(
  userId: string,
  organizationId: string,
  authSessionId = 'test-session-default',
): Promise<{
  user: {
    id: string;
    email: string;
    activeOrganizationId: string;
    membershipId: string;
    platformRoleId: string | null;
    authSessionId: string;
  };
}> {
  const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, platformRoleId: true },
  });
  const membership = await unsafePrismaAdmin.membership.findFirstOrThrow({
    where: { userId, organizationId },
    select: { id: true },
  });
  return {
    user: {
      id: userId,
      email: user.email,
      activeOrganizationId: organizationId,
      membershipId: membership.id,
      platformRoleId: user.platformRoleId,
      authSessionId,
    },
  };
}

/**
 * Phase 5: mock a JWT for a platform-plane user. No membershipId /
 * activeOrganizationId — platform accounts operate cross-tenant via
 * impersonation and break-glass.
 *
 * Supply authSessionId to match the value used in verifyPasswordFresh calls
 * for that test — the route's requireFreshPassword reads ctx.authSessionId.
 */
export async function mockPlatformJwt(
  email: string,
  authSessionId = 'test-platform-session',
): Promise<{
  user: {
    id: string;
    email: string;
    activeOrganizationId: null;
    membershipId: null;
    platformRoleId: string | null;
    authSessionId: string;
  };
}> {
  const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true, platformRoleId: true },
  });
  return {
    user: {
      id: user.id,
      email: user.email,
      activeOrganizationId: null,
      membershipId: null,
      platformRoleId: user.platformRoleId,
      authSessionId,
    },
  };
}
