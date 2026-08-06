import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { mockPlatformJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { __clearPasswordReauthCache, verifyPasswordFresh } =
  await import('@/lib/platform/password-reauth');
const { unsafePrismaAdmin } = await import('@/lib/db');

const listRoute = await import('@/app/api/platform/orgs/route');
const detailRoute = await import('@/app/api/platform/orgs/[id]/route');
const suspendRoute = await import('@/app/api/platform/orgs/[id]/suspend/route');
const reactivRoute = await import('@/app/api/platform/orgs/[id]/reactivate/route');
const deleteRoute = await import('@/app/api/platform/orgs/[id]/soft-delete/route');

// Matches the default authSessionId returned by mockPlatformJwt so grants
// created in tests are visible to the route's ctx.authSessionId.
const TEST_SESSION = 'test-platform-session';

import type { NextRequest } from 'next/server';
function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}
async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('/api/platform/orgs — list, detail, suspend, reactivate, soft-delete', () => {
  let orgId: string;
  let superUserId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const org = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' },
      select: { id: true },
    });
    orgId = org.id;
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    superUserId = su.id;
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    __clearPasswordReauthCache();
    // Reset the target org's status to active between tests.
    await unsafePrismaAdmin.organization.update({
      where: { id: orgId },
      data: { status: 'active' },
    });
  });

  it('PLATFORM_ADMIN can list orgs', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await listRoute.GET();
    expect(res.status).toBe(200);
    const body = await json<{ orgs: Array<{ id: string; name: string }> }>(res);
    expect(body.orgs.length).toBeGreaterThan(0);
    expect(body.orgs.find((o) => o.id === orgId)).toBeTruthy();
  });

  it('org-plane user (owner) has no platform.analytics.read → 403 on list', async () => {
    const { mockJwt } = await import('./helpers/session');
    authMock.mockResolvedValue(
      await mockJwt(
        (
          await unsafePrismaAdmin.appUser.findUniqueOrThrow({
            where: { email: 'split-owner@bp.test' },
            select: { id: true },
          })
        ).id,
        orgId,
      ),
    );
    const res = await listRoute.GET();
    expect(res.status).toBe(403);
  });

  it('detail returns 404 for unknown id', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await detailRoute.GET(req('http://x'), {
      params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(res.status).toBe(404);
  });

  it('suspend fails without fresh password (spec §9 rule 9)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await suspendRoute.POST(
      req('http://x', { method: 'POST', body: JSON.stringify({ reason: 'testing suspension' }) }),
      { params: Promise.resolve({ id: orgId }) },
    );
    expect(res.status).toBe(403);
  });

  it('suspend + reactivate cycle works when password is fresh', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    await verifyPasswordFresh(
      (
        await unsafePrismaAdmin.appUser.findUniqueOrThrow({
          where: { email: 'platform-admin@bp.test' },
          select: { id: true },
        })
      ).id,
      'devpass123',
      TEST_SESSION,
      'platform.org.suspend',
      { orgId },
    );
    const suspendRes = await suspendRoute.POST(
      req('http://x', { method: 'POST', body: JSON.stringify({ reason: 'testing suspension' }) }),
      { params: Promise.resolve({ id: orgId }) },
    );
    expect(suspendRes.status).toBe(200);
    const after = await unsafePrismaAdmin.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(after.status).toBe('suspended');

    const reactivateRes = await reactivRoute.POST(req('http://x'), {
      params: Promise.resolve({ id: orgId }),
    });
    expect(reactivateRes.status).toBe(200);
    const after2 = await unsafePrismaAdmin.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(after2.status).toBe('active');
  });

  it('soft-delete requires SUPER_ADMIN — PLATFORM_ADMIN gets 403', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    await verifyPasswordFresh(
      (
        await unsafePrismaAdmin.appUser.findUniqueOrThrow({
          where: { email: 'platform-admin@bp.test' },
          select: { id: true },
        })
      ).id,
      'devpass123',
      TEST_SESSION,
      'platform.org.delete',
      { orgId },
    );
    const res = await deleteRoute.POST(
      req('http://x', { method: 'POST', body: JSON.stringify({ reason: 'testing archive' }) }),
      { params: Promise.resolve({ id: orgId }) },
    );
    expect(res.status).toBe(403);
  });

  it('soft-delete works for SUPER_ADMIN', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    await verifyPasswordFresh(superUserId, 'devpass123', TEST_SESSION, 'platform.org.delete', {
      orgId,
    });
    const res = await deleteRoute.POST(
      req('http://x', { method: 'POST', body: JSON.stringify({ reason: 'testing archive' }) }),
      { params: Promise.resolve({ id: orgId }) },
    );
    expect(res.status).toBe(200);
    const after = await unsafePrismaAdmin.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(after.status).toBe('archived');
    // Restore for other suites.
    await unsafePrismaAdmin.organization.update({
      where: { id: orgId },
      data: { status: 'active' },
    });
  });
});
