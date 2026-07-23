import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { consumeRateLimit, RateLimitedError } = await import('@/lib/rate-limit');

describe('rate-limit — per-org fixed-window', () => {
  let orgId: string;

  beforeAll(async () => {
    const org = await withoutRls((tx) =>
      tx.organization.create({ data: { name: `rate-limit-${Date.now()}` } }),
    );
    orgId = org.id;
  });

  afterAll(async () => {
    if (orgId) await withoutRls((tx) => tx.organization.delete({ where: { id: orgId } }));
  });

  beforeEach(async () => {
    await withoutRls((tx) => tx.rateLimit.deleteMany({ where: { organizationId: orgId } }));
  });

  it('lets calls through under the limit', async () => {
    const r1 = await consumeRateLimit(orgId, 'assistant', 3);
    expect(r1.count).toBe(1);
    const r2 = await consumeRateLimit(orgId, 'assistant', 3);
    expect(r2.count).toBe(2);
  });

  it('throws RateLimitedError past the limit within the same minute', async () => {
    for (let i = 0; i < 2; i++) await consumeRateLimit(orgId, 'assistant', 2);
    await expect(consumeRateLimit(orgId, 'assistant', 2)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('rolls the window at the top of the next minute', async () => {
    const t0 = new Date('2027-05-05T12:34:00Z');
    const t1 = new Date('2027-05-05T12:35:00Z');
    await consumeRateLimit(orgId, 'msg', 1, t0);
    // Same minute → over limit.
    await expect(consumeRateLimit(orgId, 'msg', 1, t0)).rejects.toBeInstanceOf(RateLimitedError);
    // Next minute → fresh window.
    const r = await consumeRateLimit(orgId, 'msg', 1, t1);
    expect(r.count).toBe(1);
  });

  it('limit=0 disables enforcement and writes nothing', async () => {
    for (let i = 0; i < 20; i++) await consumeRateLimit(orgId, 'x', 0);
    const rows = await withoutRls((tx) =>
      tx.rateLimit.findMany({ where: { organizationId: orgId, bucket: 'x' } }),
    );
    expect(rows.length).toBe(0);
  });
});
