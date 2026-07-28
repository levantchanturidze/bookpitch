import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { notifyEvent } = await import('@/lib/notifications');
const listRoute = await import('@/app/api/notifications/route');
const markRoute = await import('@/app/api/notifications/mark-all-read/route');
const clearRoute = await import('@/app/api/notifications/clear/route');
const { mockJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');

async function mkSession(orgId: string, userId: string) {
  return mockJwt(userId, orgId);
}

async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('notifyEvent + notifications REST', () => {
  let primaryOrgId: string;
  let ownerId: string;
  let isolationOrgId: string;
  const trackedIds: string[] = [];

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const primary = await tx.organization.findFirst({
        where: { name: { not: 'Isolation Corp' } },
        orderBy: { createdAt: 'asc' },
      });
      const iso = await tx.organization.findFirst({
        where: { name: 'Isolation Corp' },
      });
      const owner = await tx.appUser.findUnique({
        where: { email: 'owner@bookpitch.dev' },
        select: { id: true },
      });
      return { primary, iso, owner };
    });
    primaryOrgId = seed.primary!.id;
    isolationOrgId = seed.iso!.id;
    ownerId = seed.owner!.id;
  });

  afterAll(async () => {
    if (trackedIds.length) {
      await withoutRls((tx) =>
        tx.notification.deleteMany({ where: { id: { in: trackedIds } } }),
      );
    }
  });

  beforeEach(() => {
    authMock.mockReset();
    __clearAuthContextCache();
  });

  it('notifyEvent writes a notifications row the next poll will pick up', async () => {
    const event = await withoutRls((tx) =>
      notifyEvent(tx, primaryOrgId, {
        type: 'system',
        title: 'test notify',
        body: 'body-here',
      }),
    );
    trackedIds.push(event.id);

    // Row persisted with sane defaults; the header's 30s poll picks it up.
    const row = await withoutRls((tx) =>
      tx.notification.findUnique({ where: { id: event.id } }),
    );
    expect(row).toBeTruthy();
    expect(row?.read).toBe(false);
    expect(row?.title).toBe('test notify');
    expect(row?.body).toBe('body-here');
    expect(row?.organizationId).toBe(primaryOrgId);
  });

  it('GET /api/notifications lists caller org rows in desc order', async () => {
    authMock.mockResolvedValue(await mkSession(primaryOrgId, ownerId));
    const res = await listRoute.GET();
    expect(res.status).toBe(200);
    const body = await jsonBody<{ notifications: Array<{ id: string }> }>(res);
    expect(body.notifications.length).toBeGreaterThan(0);
  });

  it('cross-tenant list stays 0 for isolation org (RLS)', async () => {
    // Phase 4: real (userId, orgId) pair required. Use isolation's own owner.
    const isoOwner = await withoutRls(tx => tx.appUser.findUniqueOrThrow({
      where: { email: 'isolation@bookpitch.dev' }, select: { id: true },
    }));
    authMock.mockResolvedValue(await mkSession(isolationOrgId, isoOwner.id));
    const res = await listRoute.GET();
    const body = await jsonBody<{ notifications: unknown[] }>(res);
    expect(body.notifications.length).toBe(0);
  });

  it('mark-all-read flips read=true for the caller org', async () => {
    // Seed one unread just for this test.
    const created = await withoutRls((tx) =>
      notifyEvent(tx, primaryOrgId, { type: 'system', title: 'unread-marker' }),
    );
    trackedIds.push(created.id);

    authMock.mockResolvedValue(await mkSession(primaryOrgId, ownerId));
    const res = await markRoute.POST();
    expect(res.status).toBe(200);

    const row = await withoutRls((tx) =>
      tx.notification.findUnique({ where: { id: created.id } }),
    );
    expect(row?.read).toBe(true);
  });

  it('clear deletes all notifications for the caller org (not other orgs)', async () => {
    // Seed one in primary + one in isolation.
    const inPrimary = await withoutRls((tx) =>
      notifyEvent(tx, primaryOrgId, { type: 'system', title: 'to-clear' }),
    );
    const inIsolation = await withoutRls((tx) =>
      notifyEvent(tx, isolationOrgId, { type: 'system', title: 'stays' }),
    );
    trackedIds.push(inPrimary.id, inIsolation.id);

    authMock.mockResolvedValue(await mkSession(primaryOrgId, ownerId));
    const res = await clearRoute.POST();
    expect(res.status).toBe(200);

    const primaryGone = await withoutRls((tx) =>
      tx.notification.findUnique({ where: { id: inPrimary.id } }),
    );
    const isolationRow = await withoutRls((tx) =>
      tx.notification.findUnique({ where: { id: inIsolation.id } }),
    );
    expect(primaryGone).toBeNull();
    expect(isolationRow).not.toBeNull();
  });
});
