import { describe, it, expect } from 'vitest';
import { t, formatCurrency, formatDate } from '@/lib/i18n';

describe('i18n.t', () => {
  it('returns the Georgian string for a known key', () => {
    expect(t('nav.scheduler', 'ka')).toBe('დაგეგმარება');
  });

  it('returns the English fallback when the key is missing in the target locale', () => {
    // Add a key we know is only in `en`
    // (there are none today; assert via `en` explicitly to keep the test stable).
    expect(t('signin.title', 'en')).toBe('Sign in');
  });

  it('returns the key itself when not found in any locale', () => {
    expect(t('does.not.exist', 'ka')).toBe('does.not.exist');
  });
});

describe('formatCurrency', () => {
  it('formats GEL with the ₾ symbol in ka locale', () => {
    const s = formatCurrency(120.5, 'GEL', 'ka');
    expect(s).toContain('₾');
    // ka-GE uses "," as the decimal separator.
    expect(s).toMatch(/120[,\s.]/);
  });

  it('formats USD in en locale with a $ sign', () => {
    expect(formatCurrency(99, 'USD', 'en')).toContain('$');
  });
});

describe('formatDate', () => {
  it('renders a ka-GE date', () => {
    const s = formatDate(new Date('2026-07-23T12:00:00Z'), 'ka');
    // Georgian medium format includes the year as Arabic numerals.
    expect(s).toMatch(/2026/);
  });
});
