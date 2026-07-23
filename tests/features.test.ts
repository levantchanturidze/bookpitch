import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { isFeatureEnabled, setFeature, FLAGS, _clearFeatureCache } = await import(
  '@/lib/features'
);

describe('feature flags', () => {
  let orgId: string;

  beforeAll(async () => {
    const org = await withoutRls((tx) =>
      tx.organization.create({ data: { name: `ff-${Date.now()}` } }),
    );
    orgId = org.id;
  });

  afterAll(async () => {
    if (orgId) await withoutRls((tx) => tx.organization.delete({ where: { id: orgId } }));
  });

  beforeEach(() => _clearFeatureCache());

  it('unknown/absent flag falls back to compile-time default', async () => {
    expect(await isFeatureEnabled(orgId, 'assistant_streaming')).toBe(
      FLAGS.assistant_streaming,
    );
  });

  it('setFeature(true) enables + persists across cache flushes', async () => {
    await setFeature(orgId, 'patient_booking_widget', true);
    _clearFeatureCache();
    expect(await isFeatureEnabled(orgId, 'patient_booking_widget')).toBe(true);
  });

  it('setFeature(false) disables', async () => {
    await setFeature(orgId, 'patient_booking_widget', false);
    _clearFeatureCache();
    expect(await isFeatureEnabled(orgId, 'patient_booking_widget')).toBe(false);
  });

  it('flags are per-org', async () => {
    const otherOrg = await withoutRls((tx) =>
      tx.organization.create({ data: { name: `ff2-${Date.now()}` } }),
    );
    try {
      await setFeature(orgId, 'insurance_codes', true);
      expect(await isFeatureEnabled(otherOrg.id, 'insurance_codes')).toBe(
        FLAGS.insurance_codes,
      );
    } finally {
      await withoutRls((tx) => tx.organization.delete({ where: { id: otherOrg.id } }));
    }
  });
});
