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

// Stable test session IDs — simulate two independent login sessions.
const SESSION_A = 'aaaa-test-session-a';
const SESSION_B = 'bbbb-test-session-b';
const PURPOSE = 'platform.mfa.enroll' as const;

describe('password re-auth (destructive-action gate)', () => {
  let superUserId: string;
  let orgAId: string;
  let orgBId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const u = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    superUserId = u.id;
    const orgA = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' },
      select: { id: true },
    });
    orgAId = orgA.id;
    const orgB = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Solo Practice' },
      select: { id: true },
    });
    orgBId = orgB.id;
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    await __clearPasswordReauthCache();
  });

  // ── Basic grant lifecycle ────────────────────────────────────────────────────

  it('requireFreshPassword denies without a prior verification', async () => {
    await expect(requireFreshPassword(superUserId, SESSION_A, PURPOSE)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('verifyPasswordFresh accepts the right password and creates a usable grant', async () => {
    const ok = await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, PURPOSE);
    expect(ok).toBe(true);
    await expect(requireFreshPassword(superUserId, SESSION_A, PURPOSE)).resolves.toBeUndefined();
  });

  it('wrong password: returns false and leaves no grant', async () => {
    const ok = await verifyPasswordFresh(superUserId, 'wrong-password', SESSION_A, PURPOSE);
    expect(ok).toBe(false);
    await expect(requireFreshPassword(superUserId, SESSION_A, PURPOSE)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('throwOnBadPassword surfaces wrong passwords as InvalidInputError', async () => {
    await expect(
      verifyPasswordFresh(superUserId, 'nope', SESSION_A, PURPOSE, { throwOnBadPassword: true }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('rate limits at 5 attempts per rolling minute', async () => {
    for (let i = 0; i < 5; i++) {
      await verifyPasswordFresh(superUserId, 'wrong', SESSION_A, PURPOSE);
    }
    await expect(
      verifyPasswordFresh(superUserId, 'wrong', SESSION_A, PURPOSE),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('grant is expired when maxAgeMs=0 at creation time', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, PURPOSE, { maxAgeMs: 0 });
    await expect(requireFreshPassword(superUserId, SESSION_A, PURPOSE)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  // ── Session binding ──────────────────────────────────────────────────────────

  it('session A grant cannot be consumed by session B', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, PURPOSE);
    await expect(requireFreshPassword(superUserId, SESSION_B, PURPOSE)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('session B grant cannot be consumed by session A', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_B, PURPOSE);
    await expect(requireFreshPassword(superUserId, SESSION_A, PURPOSE)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('each session can hold its own independent grant', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, PURPOSE);
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_B, PURPOSE);
    await expect(requireFreshPassword(superUserId, SESSION_A, PURPOSE)).resolves.toBeUndefined();
    await expect(requireFreshPassword(superUserId, SESSION_B, PURPOSE)).resolves.toBeUndefined();
  });

  it('rejects when authSessionId is empty string', async () => {
    await expect(requireFreshPassword(superUserId, '', PURPOSE)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  // ── Purpose binding ──────────────────────────────────────────────────────────

  it('enroll grant cannot satisfy confirm purpose', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, 'platform.mfa.enroll');
    await expect(
      requireFreshPassword(superUserId, SESSION_A, 'platform.mfa.confirm'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('suspend grant cannot satisfy delete purpose', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, 'platform.org.suspend', {
      orgId: orgAId,
    });
    await expect(
      requireFreshPassword(superUserId, SESSION_A, 'platform.org.delete', { orgId: orgAId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  // ── Org binding ──────────────────────────────────────────────────────────────

  it('org-A suspend grant cannot authorize org-B suspension', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, 'platform.org.suspend', {
      orgId: orgAId,
    });
    await expect(
      requireFreshPassword(superUserId, SESSION_A, 'platform.org.suspend', { orgId: orgBId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('grant without org binding cannot satisfy org-scoped requirement', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, 'platform.mfa.enroll');
    await expect(
      requireFreshPassword(superUserId, SESSION_A, 'platform.mfa.enroll', { orgId: orgAId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  // ── Single use (replay protection) ───────────────────────────────────────────

  it('grant is consumed after first use — replay is rejected', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, PURPOSE);
    await expect(requireFreshPassword(superUserId, SESSION_A, PURPOSE)).resolves.toBeUndefined();
    // Second call: grant already consumed
    await expect(requireFreshPassword(superUserId, SESSION_A, PURPOSE)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('concurrent consumption: exactly one succeeds', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, PURPOSE);
    const [r1, r2] = await Promise.allSettled([
      requireFreshPassword(superUserId, SESSION_A, PURPOSE),
      requireFreshPassword(superUserId, SESSION_A, PURPOSE),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 'fulfilled').length;
    const denied = [r1, r2].filter((r) => r.status === 'rejected').length;
    expect(ok).toBe(1);
    expect(denied).toBe(1);
  });

  // ── Session-version binding ───────────────────────────────────────────────────

  it('grant is invalidated when sessionVersion advances after issue', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, PURPOSE);
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { sessionVersion: { increment: 1 } },
    });
    await expect(requireFreshPassword(superUserId, SESSION_A, PURPOSE)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('requireFreshPassword passes after re-verification following a version bump', async () => {
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, PURPOSE);
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { sessionVersion: { increment: 1 } },
    });
    // Re-verify after the bump — captures the new session_version.
    await verifyPasswordFresh(superUserId, 'devpass123', SESSION_A, PURPOSE);
    await expect(requireFreshPassword(superUserId, SESSION_A, PURPOSE)).resolves.toBeUndefined();
  });
});
