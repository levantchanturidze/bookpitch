import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { runHousekeeping } = await import('@/lib/housekeeping');

describe('runHousekeeping', () => {
  let orgId: string;
  const email = `hk-${Date.now()}@ex.dev`;

  beforeAll(async () => {
    const org = await withoutRls((tx) =>
      tx.organization.create({ data: { name: `hk-${Date.now()}` } }),
    );
    orgId = org.id;

    // Plant one stale row of each kind + one fresh row of each kind so we
    // can assert the delete count AND that fresh data survives.
    const stale = new Date('2020-01-01T00:00:00Z');
    const fresh = new Date();

    await withoutRls(async (tx) => {
      await tx.rateLimit.createMany({
        data: [
          { organizationId: orgId, bucket: 'stale', windowStart: stale, count: 1 },
          { organizationId: orgId, bucket: 'fresh', windowStart: fresh, count: 1 },
        ],
      });
      await tx.verificationToken.createMany({
        data: [
          { identifier: email, token: 'stale-tok', expires: stale },
          {
            identifier: email,
            token: 'fresh-tok',
            expires: new Date(fresh.getTime() + 60 * 60 * 1000),
          },
        ],
      });
      await tx.notification.createMany({
        data: [
          {
            organizationId: orgId,
            title: 'stale-read',
            type: 'system',
            read: true,
            createdAt: stale,
          },
          {
            organizationId: orgId,
            title: 'stale-unread',
            type: 'system',
            read: false,
            createdAt: stale,
          },
          {
            organizationId: orgId,
            title: 'fresh-read',
            type: 'system',
            read: true,
            createdAt: fresh,
          },
        ],
      });
    });
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.rateLimit.deleteMany({ where: { organizationId: orgId } });
      await tx.notification.deleteMany({ where: { organizationId: orgId } });
      await tx.verificationToken.deleteMany({ where: { identifier: email } });
      await tx.organization.delete({ where: { id: orgId } });
    });
  });

  it('deletes stale rate_limit / expired tokens / old-read notifications and leaves fresh rows alone', async () => {
    const result = await runHousekeeping();
    expect(result.rateLimit).toBeGreaterThanOrEqual(1);
    expect(result.verificationTokens).toBeGreaterThanOrEqual(1);
    expect(result.notifications).toBeGreaterThanOrEqual(1);

    // Fresh survivors.
    const [freshRl, freshTok, freshRead, staleUnread] = await withoutRls(async (tx) => [
      await tx.rateLimit.findFirst({ where: { organizationId: orgId, bucket: 'fresh' } }),
      await tx.verificationToken.findUnique({ where: { token: 'fresh-tok' } }),
      await tx.notification.findFirst({ where: { organizationId: orgId, title: 'fresh-read' } }),
      // Stale but unread must NOT be pruned — users may still want to read it.
      await tx.notification.findFirst({
        where: { organizationId: orgId, title: 'stale-unread' },
      }),
    ]);
    expect(freshRl).toBeTruthy();
    expect(freshTok).toBeTruthy();
    expect(freshRead).toBeTruthy();
    expect(staleUnread).toBeTruthy();
  });
});
