import { describe, it, expect } from 'vitest';
import { effectivePlan, PLANS, planFromId } from '@/lib/billing/plans';

describe('planFromId', () => {
  it('returns known plans', () => {
    expect(planFromId('pro').id).toBe('pro');
    expect(planFromId('clinic').id).toBe('clinic');
    expect(planFromId('free').id).toBe('free');
  });
  it('falls back to free for unknown / null', () => {
    expect(planFromId(null).id).toBe('free');
    expect(planFromId('enterprise').id).toBe('free');
  });
});

describe('effectivePlan', () => {
  it('active pro → pro', () => {
    expect(
      effectivePlan({ plan: 'pro', planStatus: 'active', currentPeriodEnd: null }).id,
    ).toBe('pro');
  });
  it('trialing clinic → clinic', () => {
    expect(
      effectivePlan({ plan: 'clinic', planStatus: 'trialing', currentPeriodEnd: null }).id,
    ).toBe('clinic');
  });
  it('past_due still grants paid tier (grace)', () => {
    expect(
      effectivePlan({ plan: 'pro', planStatus: 'past_due', currentPeriodEnd: null }).id,
    ).toBe('pro');
  });
  it('canceled + period in future keeps paid tier', () => {
    const future = new Date(Date.now() + 24 * 3600 * 1000);
    expect(
      effectivePlan({ plan: 'pro', planStatus: 'canceled', currentPeriodEnd: future }).id,
    ).toBe('pro');
  });
  it('canceled + period past drops to free', () => {
    const past = new Date(Date.now() - 24 * 3600 * 1000);
    expect(
      effectivePlan({ plan: 'pro', planStatus: 'canceled', currentPeriodEnd: past }).id,
    ).toBe('free');
  });
});

describe('PLANS entitlements', () => {
  it('increase monotonically', () => {
    expect(PLANS.pro.entitlements.maxStaff).toBeGreaterThan(PLANS.free.entitlements.maxStaff);
    expect(PLANS.clinic.entitlements.maxStaff).toBeGreaterThan(PLANS.pro.entitlements.maxStaff);
  });
  it('SMS reminders + analytics gated by plan', () => {
    expect(PLANS.free.entitlements.smsRemindersEnabled).toBe(false);
    expect(PLANS.pro.entitlements.smsRemindersEnabled).toBe(true);
    expect(PLANS.clinic.entitlements.analyticsEnabled).toBe(true);
    expect(PLANS.free.entitlements.analyticsEnabled).toBe(false);
  });
});
