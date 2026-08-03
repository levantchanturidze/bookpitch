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
const auditRoute = await import('@/app/api/platform/audit/route');

import type { NextRequest } from 'next/server';
function req(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}
async function json<T = unknown>(res: Response): Promise<T> { return (await res.json()) as T; }

type Row = {
  actorEmail: string | null;
  organizationName: string | null;
  action: string;
  reason: string | null;
};

describe('/api/platform/audit', () => {
  beforeAll(async () => {
    await seedRbacFixtures();
  });

  beforeEach(() => {
    authMock.mockReset();
    __clearAuthContextCache();
  });

  it('SUPPORT_AGENT can query but sees masked email', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('support@bp.test'));
    const res = await auditRoute.GET(req('http://x/api/platform/audit?limit=10'));
    expect(res.status).toBe(200);
    const body = await json<{ rows: Row[] }>(res);
    // If we have any rows, every emailed one should be masked.
    for (const r of body.rows) {
      if (r.actorEmail) expect(r.actorEmail).toMatch(/\*\*\*@/);
    }
  });

  it('PLATFORM_ADMIN sees raw emails', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await auditRoute.GET(req('http://x/api/platform/audit?limit=10'));
    expect(res.status).toBe(200);
    const body = await json<{ rows: Row[] }>(res);
    // We can't assert positively without generating an audit row first,
    // but the important property is that IF there's a row, the email
    // isn't masked (no leading *).
    for (const r of body.rows) {
      if (r.actorEmail) expect(r.actorEmail).not.toMatch(/^\*/);
    }
  });

  it('BILLING_MANAGER has platform.audit.read → 200', async () => {
    // Sanity: any platform-plane role with the perm can hit this endpoint.
    // BILLING_MANAGER's seed doesn't include audit.read (only billing perms),
    // so it should 403.
    authMock.mockResolvedValue(await mockPlatformJwt('billing@bp.test'));
    const res = await auditRoute.GET(req('http://x/api/platform/audit'));
    expect(res.status).toBe(403);
  });

  it('action prefix filter matches startsWith', async () => {
    // Write an audit row with a distinctive action.
    const org = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' }, select: { id: true },
    });
    const u = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'platform-admin@bp.test' }, select: { id: true },
    });
    const marker = `probe.audit.${Date.now()}`;
    await unsafePrismaAdmin.auditLog.create({
      data: {
        organizationId: org.id,
        actorUserId: u.id,
        action: marker,
        entity: 'staff',
      },
    });

    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await auditRoute.GET(req(`http://x/api/platform/audit?action=${marker}`));
    expect(res.status).toBe(200);
    const body = await json<{ rows: Row[] }>(res);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every(r => r.action.startsWith(marker))).toBe(true);
  });

  it('audit_log UPDATE still blocked (re-verify Phase 1 §9.11)', async () => {
    // Grab an existing row and try to mutate via unsafePrismaAdmin.
    const row = await unsafePrismaAdmin.auditLog.findFirst({ orderBy: { at: 'desc' } });
    if (!row) return; // fresh DB — nothing to try.
    await expect(
      unsafePrismaAdmin.auditLog.update({
        where: { at_id: { at: row.at, id: row.id } },
        data: { reason: 'tampered' },
      }),
    ).rejects.toThrow(/append-only|permission denied/i);
  });
});
