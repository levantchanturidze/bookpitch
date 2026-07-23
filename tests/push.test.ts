import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const sendMock = vi.fn();
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => sendMock(...args),
  },
}));

const { withoutRls } = await import('@/lib/db');
const { saveSubscription, removeSubscription, pushToUser } = await import('@/lib/push');

describe('push subscription persistence', () => {
  let userId: string;

  beforeAll(async () => {
    const user = await withoutRls((tx) =>
      tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `push-${Date.now()}@ex.dev`,
          email: `push-${Date.now()}@ex.dev`,
          fullName: 'Push Tester',
          passwordHash: 'x',
        },
      }),
    );
    userId = user.id;
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.pushSubscription.deleteMany({ where: { userId } });
      await tx.appUser.delete({ where: { id: userId } });
    });
  });

  beforeEach(async () => {
    sendMock.mockReset();
    process.env.VAPID_PUBLIC_KEY =
      'BFEHVMslIL7-4Aq5U8pJqjR3Yr6-QqXqQdVW-p1LmZBqvJyz-YRuJgn0mBu7CxK_lJZeYcC4TnwzYd8IhZmL7oM';
    process.env.VAPID_PRIVATE_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF-';
    await withoutRls((tx) => tx.pushSubscription.deleteMany({ where: { userId } }));
  });

  it('saveSubscription upserts on endpoint', async () => {
    const endpoint = `https://push.example/e-${Date.now()}`;
    const first = await saveSubscription({
      userId,
      endpoint,
      p256dh: 'p1',
      auth: 'a1',
      userAgent: 'jest',
    });
    const second = await saveSubscription({
      userId,
      endpoint,
      p256dh: 'p2', // rotated keys — represents the browser reissuing
      auth: 'a2',
    });
    expect(second.id).toBe(first.id);
    const row = await withoutRls((tx) =>
      tx.pushSubscription.findUnique({ where: { endpoint } }),
    );
    expect(row?.p256dh).toBe('p2');
  });

  it('pushToUser fans out to every subscription and reports delivered count', async () => {
    for (let i = 0; i < 3; i++) {
      await saveSubscription({
        userId,
        endpoint: `https://push.example/e${i}-${Date.now()}`,
        p256dh: `p${i}`,
        auth: `a${i}`,
      });
    }
    sendMock.mockResolvedValue(undefined);
    const r = await pushToUser(userId, { title: 't', body: 'b' });
    expect(r.delivered).toBe(3);
    expect(r.pruned).toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it('pushToUser prunes subscriptions on 410 Gone', async () => {
    const alive = await saveSubscription({
      userId,
      endpoint: `https://push.example/alive-${Date.now()}`,
      p256dh: 'p',
      auth: 'a',
    });
    const dead = await saveSubscription({
      userId,
      endpoint: `https://push.example/dead-${Date.now()}`,
      p256dh: 'p',
      auth: 'a',
    });
    sendMock.mockImplementation((sub) => {
      const err = new Error('gone') as Error & { statusCode?: number };
      if ((sub as { endpoint: string }).endpoint.includes('dead')) {
        err.statusCode = 410;
        throw err;
      }
      return Promise.resolve();
    });
    const r = await pushToUser(userId, { title: 't', body: 'b' });
    expect(r.delivered).toBe(1);
    expect(r.pruned).toBe(1);
    const rows = await withoutRls((tx) =>
      tx.pushSubscription.findMany({ where: { userId } }),
    );
    expect(rows.map((r) => r.id)).toContain(alive.id);
    expect(rows.map((r) => r.id)).not.toContain(dead.id);
  });

  it('removeSubscription is idempotent', async () => {
    await expect(removeSubscription('https://does-not-exist')).resolves.toBeUndefined();
  });
});
