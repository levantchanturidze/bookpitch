// -----------------------------------------------------------------------------
// Test helper: build a Phase 4-shaped JWT mock for the `auth()` mock.
//
// Phase 3 added activeOrganizationId + membershipId + platformRoleId to the
// JWT. Phase 4 removed the legacy organizationId + role aliases. Tests that
// mock `auth()` must return this exact shape or requireAuthContext() rejects
// with UnauthenticatedError (missing membership).
//
// Usage:
//   authMock.mockResolvedValue(await mockJwt(userId, orgId));
// -----------------------------------------------------------------------------

import { unsafePrismaAdmin } from '@/lib/db';

export async function mockJwt(
  userId: string,
  organizationId: string,
): Promise<{
  user: {
    id: string;
    email: string;
    activeOrganizationId: string;
    membershipId: string;
    platformRoleId: string | null;
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
    },
  };
}

/**
 * Phase 5: mock a JWT for a platform-plane user. No membershipId /
 * activeOrganizationId — platform accounts operate cross-tenant via
 * impersonation and break-glass. lib/auth.getSession() returns null for
 * this shape (correctly — session-scoped org-plane helpers can't run for
 * a platform-only user), but requireAuthContext() builds a valid
 * platform-only AuthContext with ctx.platformPermissions populated.
 *
 * Note: getSession() null means routes wrapped ONLY in withApi never
 * proceed. Phase 5 routes use withPlatformApi which calls
 * requireAuthContext directly, so platform-only sessions pass.
 */
export async function mockPlatformJwt(email: string): Promise<{
  user: {
    id: string;
    email: string;
    activeOrganizationId: null;
    membershipId: null;
    platformRoleId: string | null;
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
    },
  };
}
