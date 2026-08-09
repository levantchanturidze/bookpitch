// -----------------------------------------------------------------------------
// Complement-path tests for POST /api/platform/reauth.
//
// These cover the route layer (auth context + purpose binding), complementing
// the lower-level verifyPasswordFresh / requireFreshPassword tests in
// platform-password-reauth.test.ts.
//
// The key regression being proven: the route MUST reject calls that omit
// `purpose` with 400. Before the OrgDetail.tsx fix, the UI sent { password }
// with no `purpose`, so every reauth call returned 400 — the suspend, delete,
// and toggle-change flows were silently broken.
// -----------------------------------------------------------------------------

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { mockPlatformJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { __clearPasswordReauthCache } = await import('@/lib/platform/password-reauth');
const { unsafePrismaAdmin } = await import('@/lib/db');
const reauthRoute = await import('@/app/api/platform/reauth/route');

import type { NextRequest } from 'next/server';
function req(body: Record<string, unknown>): NextRequest {
  return new Request('http://x/api/platform/reauth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('POST /api/platform/reauth — purpose binding', () => {
  beforeAll(async () => {
    await seedRbacFixtures();
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    await __clearPasswordReauthCache();
  });

  // ── Unauthenticated ─────────────────────────────────────────────────────────

  it('returns 401 when no session', async () => {
    authMock.mockResolvedValue(null);
    const res = await reauthRoute.POST(
      req({ password: 'devpass123', purpose: 'platform.mfa.enroll' }),
    );
    expect(res.status).toBe(401);
  });

  // ── Missing / invalid purpose ─────────────────────────────────────────────

  it('returns 400 when purpose is omitted — this was the silent UI bug', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    // The old OrgDetail.tsx sent only { password } with no purpose.
    const res = await reauthRoute.POST(req({ password: 'devpass123' }));
    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toMatch(/purpose/i);
  });

  it('returns 400 when purpose is an unrecognised string', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await reauthRoute.POST(
      req({ password: 'devpass123', purpose: 'platform.org.launch_nukes' }),
    );
    expect(res.status).toBe(400);
  });

  // ── Wrong password ─────────────────────────────────────────────────────────

  it('returns 400 when password is wrong', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await reauthRoute.POST(
      req({ password: 'definitely-wrong', purpose: 'platform.mfa.enroll' }),
    );
    expect(res.status).toBe(400);
  });

  // ── Success + grant is consumed by the target operation ───────────────────

  it('returns 200 and creates a grant consumable by the named purpose', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await reauthRoute.POST(
      req({ password: 'devpass123', purpose: 'platform.mfa.enroll' }),
    );
    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean }>(res);
    expect(body.ok).toBe(true);

    // The grant must now exist in the DB.
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    const grant = await unsafePrismaAdmin.platformReauthGrant.findFirst({
      where: {
        userId: su.id,
        purpose: 'platform.mfa.enroll',
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    expect(grant).toBeTruthy();
  });

  it('org-scoped grant (orgId present) is stored with the orgId', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const org = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' },
      select: { id: true },
    });
    const res = await reauthRoute.POST(
      req({ password: 'devpass123', purpose: 'platform.org.suspend', orgId: org.id }),
    );
    expect(res.status).toBe(200);

    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    const grant = await unsafePrismaAdmin.platformReauthGrant.findFirst({
      where: {
        userId: su.id,
        purpose: 'platform.org.suspend',
        orgId: org.id,
        consumedAt: null,
      },
    });
    expect(grant).toBeTruthy();
    expect(grant?.orgId).toBe(org.id);
  });

  // ── Purpose cross-use is blocked by requireFreshPassword ─────────────────
  //
  // A grant created for 'platform.mfa.enroll' cannot satisfy
  // 'platform.org.suspend' — the backend enforces this in requireFreshPassword.
  // This test confirms the separation works end-to-end.

  it('grant for purpose A does NOT satisfy purpose B (purpose isolation)', async () => {
    const { requireFreshPassword } = await import('@/lib/platform/password-reauth');
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));

    // Create a grant for mfa.enroll.
    const reauthRes = await reauthRoute.POST(
      req({ password: 'devpass123', purpose: 'platform.mfa.enroll' }),
    );
    expect(reauthRes.status).toBe(200);

    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });

    // Attempting to consume it as 'platform.org.suspend' must fail.
    const { ForbiddenError } = await import('@/lib/auth');
    await expect(
      requireFreshPassword(su.id, 'test-platform-session', 'platform.org.suspend'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
