import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { __clearPasswordReauthCache, verifyPasswordFresh, requireFreshPassword } =
  await import('@/lib/platform/password-reauth');
const { ForbiddenError, InvalidInputError } = await import('@/lib/auth');
const { unsafePrismaAdmin } = await import('@/lib/db');

describe('password re-auth (destructive-action gate)', () => {
  let superUserId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const u = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    superUserId = u.id;
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    await __clearPasswordReauthCache();
  });

  it('requireFreshPassword denies without a prior verification', async () => {
    await expect(requireFreshPassword(superUserId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('verifyPasswordFresh accepts the right password + marks the user fresh', async () => {
    const ok = await verifyPasswordFresh(superUserId, 'devpass123');
    expect(ok).toBe(true);
    await expect(requireFreshPassword(superUserId)).resolves.toBeUndefined();
  });

  it('wrong password: returns false and stays not-fresh', async () => {
    const ok = await verifyPasswordFresh(superUserId, 'wrong-password');
    expect(ok).toBe(false);
    await expect(requireFreshPassword(superUserId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('throwOnBadPassword surfaces wrong passwords as InvalidInputError', async () => {
    await expect(
      verifyPasswordFresh(superUserId, 'nope', { throwOnBadPassword: true }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('rate limits at 5 attempts per rolling minute', async () => {
    for (let i = 0; i < 5; i++) {
      await verifyPasswordFresh(superUserId, 'wrong');
    }
    // 6th attempt within the window should trip.
    await expect(verifyPasswordFresh(superUserId, 'wrong')).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('freshness expires after maxAgeMs', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123');
    // Ask for a negative window → any past verification is stale.
    await expect(requireFreshPassword(superUserId, -1)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
