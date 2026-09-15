import { describe, it, expect } from 'vitest';
import { localMonthRange, MONTH_PARAM_RE, currentLocalYearMonth } from '@/lib/tz';

// -----------------------------------------------------------------------------
// 5.3 / 5.4 — the timezone half, as pure functions.
//
// The database-backed half (overlap rejection, invalid clock rejection, day-off
// enforcement, the never-configured fall-through) lives in
// tests/admin.test.ts and tests/available-slots.test.ts, which already have the
// org/staff/location harness. This file pins the date maths those depend on,
// because every defect in this area was a date-maths defect wearing a
// persistence costume.
// -----------------------------------------------------------------------------

const TBILISI = 'Asia/Tbilisi'; // UTC+4, no DST
const NEGATIVE = 'America/Los_Angeles'; // UTC-7/-8, DST

describe('localMonthRange — query bounds and display anchor are different things', () => {
  it('anchors on the first of the REQUESTED month, not a widened boundary', () => {
    // THE 5.4 DEFECT. The page computed `Date.UTC(y, m, 1) - 86400_000` as a
    // query boundary and then displayed it, so on 2026-09-15 the heading read
    // "August 2026" over a September grid.
    const { anchorLocalDate } = localMonthRange('2026-09', TBILISI);
    expect(anchorLocalDate).toBe('2026-09-01');
  });

  it('starts at local midnight, which is the PREVIOUS UTC day for a positive offset', () => {
    // Tbilisi September begins at 2026-08-31T20:00Z. This is the case the old
    // code papered over by widening a day in each direction; stating it exactly
    // means no widening is needed.
    const { start } = localMonthRange('2026-09', TBILISI);
    expect(start.toISOString()).toBe('2026-08-31T20:00:00.000Z');
  });

  it('is half-open: the end is the first local instant of the NEXT month', () => {
    const { end } = localMonthRange('2026-09', TBILISI);
    expect(end.toISOString()).toBe('2026-09-30T20:00:00.000Z');
  });

  it('handles a negative offset, where local midnight is LATER in UTC', () => {
    const { start } = localMonthRange('2026-09', NEGATIVE);
    expect(start.toISOString()).toBe('2026-09-01T07:00:00.000Z');
  });

  it('rolls December into January without a manual wrap', () => {
    // The classic off-by-one in this shape of helper.
    const { start, end } = localMonthRange('2026-12', 'UTC');
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('never spans more than the repository 62-day bound', () => {
    for (const m of ['2026-01', '2026-02', '2026-07', '2026-12']) {
      const { start, end } = localMonthRange(m, TBILISI);
      const days = (end.getTime() - start.getTime()) / 86_400_000;
      expect(days).toBeLessThanOrEqual(62);
      expect(days).toBeGreaterThan(27);
    }
  });

  it('refuses a malformed month rather than computing something plausible', () => {
    for (const bad of ['2026-13', '2026-00', '26-09', '2026-9', 'september', '']) {
      expect(() => localMonthRange(bad, TBILISI), bad).toThrow();
    }
  });
});

describe('MONTH_PARAM_RE — what the route accepts', () => {
  it('accepts a real YYYY-MM', () => {
    expect(MONTH_PARAM_RE.test('2026-09')).toBe(true);
    expect(MONTH_PARAM_RE.test('2026-01')).toBe(true);
    expect(MONTH_PARAM_RE.test('2026-12')).toBe(true);
  });

  it('rejects out-of-range and injection-shaped input', () => {
    for (const bad of [
      '2026-13',
      '2026-00',
      '2026-1',
      "2026-09'; DROP",
      '../../etc',
      '2026-09-01',
    ]) {
      expect(MONTH_PARAM_RE.test(bad), bad).toBe(false);
    }
  });
});

describe('currentLocalYearMonth — the month the USER is in', () => {
  it('uses the local month, not the UTC one, at a positive-offset boundary', () => {
    // 2026-09-30T21:00Z is already 2026-10-01 in Tbilisi. Opening the scheduler
    // on September there would show the user a month they have left.
    const at = new Date('2026-09-30T21:00:00Z');
    expect(currentLocalYearMonth(TBILISI, at)).toBe('2026-10');
    expect(currentLocalYearMonth('UTC', at)).toBe('2026-09');
  });

  it('uses the local month at a negative-offset boundary too', () => {
    // 2026-10-01T03:00Z is still 2026-09-30 in Los Angeles.
    const at = new Date('2026-10-01T03:00:00Z');
    expect(currentLocalYearMonth(NEGATIVE, at)).toBe('2026-09');
    expect(currentLocalYearMonth('UTC', at)).toBe('2026-10');
  });
});
