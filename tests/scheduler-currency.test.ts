import { describe, it, expect } from 'vitest';
import { formatCurrency } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// U-02 regression — production UAT 2026-09-25.
//
// The booking modal rendered `(${s.price} · 30 min)` and `price snapshot
// $100` — a literal dollar sign — for an organisation whose `currency` column
// is GEL and whose services table displayed "100.00 GEL" on the same screen.
//
// The component now formats through lib/i18n formatCurrency() with the
// organisation's own currency, which is threaded from
// app/(app)/scheduler/page.tsx.
// ---------------------------------------------------------------------------
describe('U-02 scheduler currency', () => {
  it('formats a GEL price without a dollar sign', () => {
    const out = formatCurrency(100, 'GEL');
    expect(out).not.toContain('$');
    expect(out).toMatch(/100/);
  });

  it('honours the organisation currency rather than a hard-coded symbol', () => {
    const gel = formatCurrency(100, 'GEL');
    const usd = formatCurrency(100, 'USD');
    expect(gel).not.toBe(usd);
    expect(usd).toContain('$');
  });

  it('the scheduler no longer contains a hard-coded currency symbol', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('components/scheduler/SchedulerView.tsx', 'utf8');
    // The exact two fragments that shipped the defect.
    expect(src).not.toContain('(${s.price}');
    expect(src).not.toContain('price snapshot ${');
    // And the replacement is actually wired, not merely removed.
    expect(src).toContain('formatCurrency(s.price, currency)');
    expect(src).toContain('formatCurrency(activeService.price, currency)');
  });
});
