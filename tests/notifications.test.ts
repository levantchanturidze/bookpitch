import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { CHANNEL, notifyEvent } = await import('@/lib/notifications');
const listRoute = await import('@/app/api/notifications/route');
const markRoute = await import('@/app/api/notifications/mark-all-read/route');
const clearRoute = await import('@/app/api/notifications/clear/route');

function mkSession(orgId: string, userId: string) {
  return {
    user: {
      id: userId,
      email: 'owner@example.dev',
      organizationId: orgId,
      role: 'owner' as const,
    },
  };
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

  beforeEach(() => authMock.mockReset());

  it('notifyEvent writes a notifications row + emits pg_notify on CHANNEL', async () => {
    const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL;
    const listener = new Client({ connectionString });
    await listener.connect();
    await listener.query(`LISTEN ${CHANNEL}`);

    const received: string[] = [];
    listener.on('notification', (msg) => {
      if (msg.payload) received.push(msg.payload);
    });

    // Give the LISTEN a beat to bind.
    await new Promise((r) => setTimeout(r, 100));

    const event = await withoutRls((tx) =>
      notifyEvent(tx, primaryOrgId, {
        type: 'system',
        title: 'test notify',
        body: 'body-here',
      }),
    );
    trackedIds.push(event.id);

    // Wait a tick for the LISTEN callback to fire.
    await new Promise((r) => setTimeout(r, 200));
    await listener.query(`UNLISTEN ${CHANNEL}`);
    await listener.end();

    expect(received.length).toBeGreaterThan(0);
    const parsed = received.map((p) => JSON.parse(p));
    const mine = parsed.find((p) => p.id === event.id);
    expect(mine).toBeTruthy();
    expect(mine.orgId).toBe(primaryOrgId);
    expect(mine.type).toBe('system');
    expect(mine.title).toBe('test notify');

    // Row also persisted.
    const row = await withoutRls((tx) =>
      tx.notification.findUnique({ where: { id: event.id } }),
    );
    expect(row).toBeTruthy();
    expect(row?.read).toBe(false);
  });

  it('GET /api/notifications lists caller org rows in desc order', async () => {
    authMock.mockResolvedValue(mkSession(primaryOrgId, ownerId));
    const res = await listRoute.GET();
    expect(res.status).toBe(200);
    const body = await jsonBody<{ notifications: Array<{ id: string }> }>(res);
    expect(body.notifications.length).toBeGreaterThan(0);
  });

  it('cross-tenant list stays 0 for isolation org (RLS)', async () => {
    authMock.mockResolvedValue(mkSession(isolationOrgId, ownerId));
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

    authMock.mockResolvedValue(mkSession(primaryOrgId, ownerId));
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

    authMock.mockResolvedValue(mkSession(primaryOrgId, ownerId));
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
