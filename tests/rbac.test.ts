import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Mock the Auth.js `auth()` call BEFORE importing anything that uses it —
// otherwise lib/rbac/guard.ts captures the real one.
const authMock = vi.fn();
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// Now safe to import — these transitively bind to the mocked auth().
const { ForbiddenError, UnauthenticatedError } = await import('@/lib/auth');
const { requireAuthContext } = await import('@/lib/rbac');
const { GET: whoamiOwner } = await import('@/app/api/dev/whoami-owner/route');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { prismaAdmin } = await import('@/lib/db');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');

async function jwtFor(email: string) {
  const user = await prismaAdmin.appUser.findUniqueOrThrow({ where: { email } });
  const membership = await prismaAdmin.membership.findFirstOrThrow({ where: { userId: user.id } });
  return {
    user: {
      id: user.id,
      email: user.email,
      activeOrganizationId: membership.organizationId,
      membershipId: membership.id,
      platformRoleId: null,
      organizationId: membership.organizationId,
      role: membership.role,
    },
  };
}

describe('requireAuthContext()', () => {
  beforeAll(async () => {
    await seedRbacFixtures();
  });

  beforeEach(() => {
    authMock.mockReset();
    __clearAuthContextCache();
  });

  it('throws UnauthenticatedError when there is no session', async () => {
    authMock.mockResolvedValue(null);
    await expect(requireAuthContext()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('returns an AuthContext for a valid session', async () => {
    authMock.mockResolvedValue(await jwtFor('split-owner@bp.test'));
    const ctx = await requireAuthContext();
    expect(ctx.roleKey).toBe('ORG_OWNER');
    expect(ctx.activeOrganizationId).toBeTruthy();
  });
});

describe('GET /api/dev/whoami-owner (permission gate: org.settings.update:org)', () => {
  beforeAll(async () => {
    await seedRbacFixtures();
  });

  beforeEach(() => {
    authMock.mockReset();
    __clearAuthContextCache();
  });

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(null);
    const res = await whoamiOwner();
    expect(res.status).toBe(401);
  });

  it('returns 403 for a PROVIDER (no org.settings.update:org)', async () => {
    authMock.mockResolvedValue(await jwtFor('moonlight@bp.test'));
    const res = await whoamiOwner();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/permission/);
  });

  it('returns 200 for an ORG_OWNER', async () => {
    authMock.mockResolvedValue(await jwtFor('split-owner@bp.test'));
    const res = await whoamiOwner();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.session.userId).toBeTruthy();
  });
});
