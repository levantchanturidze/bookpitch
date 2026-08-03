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
const { __clearPasswordReauthCache } = await import('@/lib/platform/password-reauth');
const { unsafePrismaAdmin } = await import('@/lib/db');
const bgRoute        = await import('@/app/api/platform/break-glass/route');
const bgEndRoute     = await import('@/app/api/platform/break-glass/end/route');
const orgsListRoute  = await import('@/app/api/platform/orgs/route');
const { requireAuthContext, can } = await import('@/lib/rbac');

import type { NextRequest } from 'next/server';
function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}
async function json<T = unknown>(res: Response): Promise<T> { return (await res.json()) as T; }

describe('/api/platform/break-glass', () => {
  let orgId: string;
  let superUserId: string;
  let platformAdminId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const org = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' }, select: { id: true },
    });
    orgId = org.id;
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' }, select: { id: true },
    });
    superUserId = su.id;
    const pa = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'platform-admin@bp.test' }, select: { id: true },
    });
    platformAdminId = pa.id;
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    __clearPasswordReauthCache();
    await unsafePrismaAdmin.breakGlassSession.deleteMany({
      where: { actorUserId: { in: [superUserId, platformAdminId] } },
    });
  });

  it('SUPER_ADMIN starts with correct password', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await bgRoute.POST(req('http://x', {
      method: 'POST',
      body: JSON.stringify({
        password: 'devpass123', reason: 'triage-check', ticketId: 'BG-1',
      }),
    }));
    expect(res.status).toBe(200);
    const body = await json<{ sessionId: string }>(res);
    const s = await unsafePrismaAdmin.breakGlassSession.findUniqueOrThrow({ where: { id: body.sessionId } });
    expect(s.actorUserId).toBe(superUserId);
    expect(s.reason).toBe('triage-check');
  });

  it('wrong password → 400', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await bgRoute.POST(req('http://x', {
      method: 'POST',
      body: JSON.stringify({
        password: 'wrong', reason: 'wrong-pw-check', ticketId: 'BG-2',
      }),
    }));
    expect(res.status).toBe(400);
  });

  it('PLATFORM_ADMIN cannot start (SUPER_ADMIN only)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await bgRoute.POST(req('http://x', {
      method: 'POST',
      body: JSON.stringify({
        password: 'devpass123', reason: 'not-allowed', ticketId: 'BG-3',
      }),
    }));
    expect(res.status).toBe(403);
  });

  it('active session populates ctx.breakGlass + isBreakGlass', async () => {
    await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        targetOrganizationId: orgId,
        reason: 'ctx-check', ticketId: 'BG-4',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const ctx = await requireAuthContext();
    expect(ctx.isBreakGlass).toBe(true);
    expect(ctx.breakGlass?.targetOrganizationId).toBe(orgId);

    // Break-glass reach: SUPER_ADMIN with no membership can can()-read
    // clinical + PII within the target org.
    expect(can(ctx, 'clinical_note.read:any', { organizationId: orgId })).toBe(true);
    expect(can(ctx, 'client.read:full', { organizationId: orgId })).toBe(true);
    // …but NOT in a different org.
    const otherOrg = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Isolation Corp' }, select: { id: true },
    });
    expect(can(ctx, 'clinical_note.read:any', { organizationId: otherOrg.id })).toBe(false);
  });

  it('every read during a break-glass session writes an audit row', async () => {
    const bg = await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        targetOrganizationId: null,
        reason: 'audit-read', ticketId: 'BG-5',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));

    const beforeCount = await unsafePrismaAdmin.auditLog.count({
      where: { breakGlassSessionId: bg.id, action: { startsWith: 'break_glass.read.' } },
    });
    // A single GET /api/platform/orgs (list) should write one audit row
    // via withPlatformApi's post-hook.
    const res = await orgsListRoute.GET();
    expect(res.status).toBe(200);
    // audit write is a floating .catch — wait a tick.
    await new Promise(r => setTimeout(r, 50));
    const afterCount = await unsafePrismaAdmin.auditLog.count({
      where: { breakGlassSessionId: bg.id, action: { startsWith: 'break_glass.read.' } },
    });
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it('expired break-glass session drops out of ctx', async () => {
    await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        reason: 'expired', ticketId: 'BG-6',
        startedAt: new Date(Date.now() - 2 * 60 * 60_000),
        expiresAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const ctx = await requireAuthContext();
    expect(ctx.breakGlass).toBeNull();
    expect(ctx.isBreakGlass).toBe(false);
  });

  it('audit_log UPDATE still fails (re-verify Phase 1 §9.11 during a BG session)', async () => {
    // Add + look up an audit row, then try to update it via the admin
    // client — the trigger should raise.
    const bg = await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        reason: 'no-update', ticketId: 'BG-7',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    // Grab any existing row to attempt an update.
    const row = await unsafePrismaAdmin.auditLog.findFirst({
      where: { breakGlassSessionId: bg.id },
      orderBy: { at: 'desc' },
    });
    if (!row) {
      // Insert one so we have a target.
      const created = await unsafePrismaAdmin.auditLog.create({
        data: {
          organizationId: orgId,
          actorUserId: superUserId,
          action: 'probe.for.update',
          entity: 'staff',
          breakGlassSessionId: bg.id,
        },
      });
      await expect(
        unsafePrismaAdmin.auditLog.update({
          where: { at_id: { at: created.at, id: created.id } },
          data: { action: 'tampered' },
        }),
      ).rejects.toThrow(/append-only|permission denied/i);
    } else {
      await expect(
        unsafePrismaAdmin.auditLog.update({
          where: { at_id: { at: row.at, id: row.id } },
          data: { action: 'tampered' },
        }),
      ).rejects.toThrow(/append-only|permission denied/i);
    }
  });

  it('end marks session ended', async () => {
    const bg = await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        reason: 'end-check', ticketId: 'BG-8',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await bgEndRoute.POST(req('http://x', {
      method: 'POST', body: JSON.stringify({ reason: 'done' }),
    }));
    expect(res.status).toBe(200);
    const after = await unsafePrismaAdmin.breakGlassSession.findUniqueOrThrow({ where: { id: bg.id } });
    expect(after.endedAt).toBeTruthy();
    expect(after.endedReason).toBe('done');
  });
});
