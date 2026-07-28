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

import { prismaAdmin } from '@/lib/db';

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
  const user = await prismaAdmin.appUser.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, platformRoleId: true },
  });
  const membership = await prismaAdmin.membership.findFirstOrThrow({
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
