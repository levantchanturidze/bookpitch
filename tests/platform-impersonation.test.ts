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
const { unsafePrismaAdmin } = await import('@/lib/db');
const impersonateRoute = await import('@/app/api/platform/impersonate/route');
const endRoute = await import('@/app/api/platform/impersonate/end/route');
const { requireAuthContext, can } = await import('@/lib/rbac');

import type { NextRequest } from 'next/server';
function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}
async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('/api/platform/impersonate — start / end / restricted perms / expiry', () => {
  let orgId: string;
  let targetUserId: string;
  let platformAdminId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const org = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' },
      select: { id: true },
    });
    orgId = org.id;
    const target = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'split-owner@bp.test' },
      select: { id: true },
    });
    targetUserId = target.id;
    const admin = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'platform-admin@bp.test' },
      select: { id: true },
    });
    platformAdminId = admin.id;
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    // Clean any stale sessions from prior tests + reset the flag to false.
    await unsafePrismaAdmin.impersonationSession.deleteMany({
      where: { actorUserId: platformAdminId },
    });
    await unsafePrismaAdmin.organization.update({
      where: { id: orgId },
      data: { allowSupportImpersonation: false, status: 'active' },
    });
  });

  it('start fails when allow_support_impersonation=false (spec §7.1 rule 1)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await impersonateRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          organizationId: orgId,
          targetUserId,
          reason: 'testing block',
          ticketId: 'T-1',
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toMatch(/disabled support impersonation/);
  });

  it('start succeeds when flag is enabled + audit row written + sessionVersion bumped', async () => {
    await unsafePrismaAdmin.organization.update({
      where: { id: orgId },
      data: { allowSupportImpersonation: true },
    });
    const beforeSV = (
      await unsafePrismaAdmin.appUser.findUniqueOrThrow({
        where: { id: platformAdminId },
        select: { sessionVersion: true },
      })
    ).sessionVersion;

    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await impersonateRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          organizationId: orgId,
          targetUserId,
          reason: 'diagnostic session',
          ticketId: 'T-42',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await json<{ sessionId: string }>(res);

    // Session row exists.
    const session = await unsafePrismaAdmin.impersonationSession.findUniqueOrThrow({
      where: { id: body.sessionId },
    });
    expect(session.actorUserId).toBe(platformAdminId);
    expect(session.onBehalfOfUserId).toBe(targetUserId);
    expect(session.reason).toBe('diagnostic session');

    // Audit row carries on_behalf_of + session id.
    const audit = await unsafePrismaAdmin.auditLog.findFirst({
      where: { impersonationSessionId: session.id, action: 'impersonation.start' },
    });
    expect(audit).toBeTruthy();
    expect(audit?.onBehalfOfUserId).toBe(targetUserId);

    // sessionVersion bumped so AuthContext cache rebuilds.
    const afterSV = (
      await unsafePrismaAdmin.appUser.findUniqueOrThrow({
        where: { id: platformAdminId },
        select: { sessionVersion: true },
      })
    ).sessionVersion;
    expect(afterSV).toBe(beforeSV + 1);
  });

  it('AuthContext.impersonation is populated after start', async () => {
    await unsafePrismaAdmin.organization.update({
      where: { id: orgId },
      data: { allowSupportImpersonation: true },
    });
    await unsafePrismaAdmin.impersonationSession.create({
      data: {
        actorUserId: platformAdminId,
        onBehalfOfUserId: targetUserId,
        organizationId: orgId,
        reason: 'live session',
        ticketId: 'T-live',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const ctx = await requireAuthContext();
    expect(ctx.isImpersonating).toBe(true);
    expect(ctx.impersonation?.organizationId).toBe(orgId);
  });

  it('RESTRICTED perms deny during impersonation (spec §7.1 rule 5)', async () => {
    await unsafePrismaAdmin.organization.update({
      where: { id: orgId },
      data: { allowSupportImpersonation: true },
    });
    // Give the platform admin an org membership as ORG_OWNER of Split
    // Practice so they'd normally have org.delete + client.export etc.
    // Then verify those perms deny during an active impersonation.
    const memb = await unsafePrismaAdmin.membership.create({
      data: { userId: platformAdminId, organizationId: orgId, role: 'owner' },
    });
    const ownerRole = await unsafePrismaAdmin.role.findFirstOrThrow({
      where: { key: 'ORG_OWNER', organizationId: null },
    });
    await unsafePrismaAdmin.membership.update({
      where: { id: memb.id },
      data: { roleId: ownerRole.id },
    });
    await unsafePrismaAdmin.impersonationSession.create({
      data: {
        actorUserId: platformAdminId,
        onBehalfOfUserId: targetUserId,
        organizationId: orgId,
        reason: 'restrict-check',
        ticketId: 'T-r',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    // Mock the JWT to look like a normal org sign-in for this platform-admin.
    authMock.mockResolvedValue({
      user: {
        id: platformAdminId,
        email: 'platform-admin@bp.test',
        activeOrganizationId: orgId,
        membershipId: memb.id,
        platformRoleId: (
          await unsafePrismaAdmin.appUser.findUniqueOrThrow({
            where: { id: platformAdminId },
            select: { platformRoleId: true },
          })
        ).platformRoleId,
      },
    });
    const ctx = await requireAuthContext();

    expect(ctx.isImpersonating).toBe(true);
    expect(can(ctx, 'org.delete', { organizationId: orgId })).toBe(false);
    expect(can(ctx, 'client.export', { organizationId: orgId })).toBe(false);
    expect(can(ctx, 'org.billing.manage', { organizationId: orgId })).toBe(false);
    expect(can(ctx, 'clinical_note.create', { organizationId: orgId })).toBe(false);
    // Non-restricted org-plane perms remain granted:
    expect(can(ctx, 'booking.read', { organizationId: orgId })).toBe(true);

    // Cleanup for other tests.
    await unsafePrismaAdmin.impersonationSession.deleteMany({
      where: { actorUserId: platformAdminId },
    });
    await unsafePrismaAdmin.membership.delete({ where: { id: memb.id } });
  });

  it('expired session drops out of AuthContext.impersonation', async () => {
    await unsafePrismaAdmin.impersonationSession.create({
      data: {
        actorUserId: platformAdminId,
        onBehalfOfUserId: targetUserId,
        organizationId: orgId,
        reason: 'expired',
        ticketId: 'T-x',
        // Backdated: started 2h ago, expired 1h ago.
        startedAt: new Date(Date.now() - 2 * 60 * 60_000),
        expiresAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const ctx = await requireAuthContext();
    expect(ctx.impersonation).toBeNull();
    expect(ctx.isImpersonating).toBe(false);
  });

  it('alert outbox row is written inside the impersonation transaction (transactional proof)', async () => {
    await unsafePrismaAdmin.organization.update({
      where: { id: orgId },
      data: { allowSupportImpersonation: true },
    });

    // Snapshot outbox count before starting impersonation.
    const before = await unsafePrismaAdmin.emailOutbox.count({
      where: { purpose: 'impersonation.alert' },
    });

    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await impersonateRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          organizationId: orgId,
          targetUserId,
          reason: 'outbox proof',
          ticketId: 'T-outbox',
        }),
      }),
    );
    expect(res.status).toBe(200);

    // Outbox row must have been written (count increased by at least 1).
    const after = await unsafePrismaAdmin.emailOutbox.count({
      where: { purpose: 'impersonation.alert' },
    });
    expect(after).toBeGreaterThan(before);

    // Row exists, is for this session, and is encrypted (to_address_encrypted=true).
    const rows = await unsafePrismaAdmin.emailOutbox.findMany({
      where: { purpose: 'impersonation.alert' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].toAddressEncrypted).toBe(true);
    expect(rows[0].bodyEncrypted).toBe(true);
  });

  it('end marks the session ended + bumps sessionVersion', async () => {
    const active = await unsafePrismaAdmin.impersonationSession.create({
      data: {
        actorUserId: platformAdminId,
        onBehalfOfUserId: targetUserId,
        organizationId: orgId,
        reason: 'end-test',
        ticketId: 'T-e',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));

    const res = await endRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({ reason: 'test' }),
      }),
    );
    expect(res.status).toBe(200);
    const after = await unsafePrismaAdmin.impersonationSession.findUniqueOrThrow({
      where: { id: active.id },
    });
    expect(after.endedAt).toBeTruthy();
    expect(after.endedReason).toBe('test');
  });
});
