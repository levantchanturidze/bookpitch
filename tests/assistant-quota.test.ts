import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { AssistantQuotaExceededError, consumeAssistantQuota, currentYearMonth } = await import(
  '@/lib/assistant/quota'
);

// -----------------------------------------------------------------------------
// Per-org monthly assistant quota. Uses a throwaway org so it doesn't perturb
// tests that assert exact counts on the seeded orgs.
// -----------------------------------------------------------------------------

describe('assistant quota — monthly per-org cap', () => {
  let orgId: string;

  beforeAll(async () => {
    const org = await withoutRls((tx) =>
      tx.organization.create({ data: { name: `quota-test-${Date.now()}` } }),
    );
    orgId = org.id;
  });

  afterAll(async () => {
    if (orgId) {
      await withoutRls((tx) => tx.organization.delete({ where: { id: orgId } }));
    }
  });

  beforeEach(async () => {
    // Wipe rows for our probe org between tests.
    await withoutRls((tx) =>
      tx.assistantUsage.deleteMany({ where: { organizationId: orgId } }),
    );
  });

  it('increments the current-month counter atomically', async () => {
    process.env.ASSISTANT_MONTHLY_CAP_PER_ORG = '5';
    const first = await consumeAssistantQuota(orgId);
    expect(first.count).toBe(1);
    expect(first.cap).toBe(5);
    const second = await consumeAssistantQuota(orgId);
    expect(second.count).toBe(2);

    const row = await withoutRls((tx) =>
      tx.assistantUsage.findFirst({ where: { organizationId: orgId } }),
    );
    expect(row?.count).toBe(2);
    expect(row?.yearMonth).toBe(currentYearMonth());
  });

  it('throws AssistantQuotaExceededError past the cap', async () => {
    process.env.ASSISTANT_MONTHLY_CAP_PER_ORG = '2';
    await consumeAssistantQuota(orgId);
    await consumeAssistantQuota(orgId);
    await expect(consumeAssistantQuota(orgId)).rejects.toBeInstanceOf(
      AssistantQuotaExceededError,
    );
  });

  it('cap=0 disables enforcement entirely', async () => {
    process.env.ASSISTANT_MONTHLY_CAP_PER_ORG = '0';
    // 20 calls should all pass; nothing is written.
    for (let i = 0; i < 20; i++) {
      const r = await consumeAssistantQuota(orgId);
      expect(r.cap).toBe(0);
    }
    const row = await withoutRls((tx) =>
      tx.assistantUsage.findFirst({ where: { organizationId: orgId } }),
    );
    expect(row).toBeNull();
  });

  it('scopes by (org, year_month) — a prior month does not consume this month', async () => {
    process.env.ASSISTANT_MONTHLY_CAP_PER_ORG = '2';
    const nowYm = currentYearMonth();
    // Plant a "used up" row for last month.
    const lastMonth = nowYm % 100 === 1 ? nowYm - 100 + 11 : nowYm - 1;
    await withoutRls((tx) =>
      tx.assistantUsage.create({
        data: { organizationId: orgId, yearMonth: lastMonth, count: 999 },
      }),
    );

    const r = await consumeAssistantQuota(orgId);
    expect(r.count).toBe(1);
  });
});
