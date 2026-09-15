import { describe, expect, it } from 'vitest';
import { requireExactCleanupId } from '@/lib/cleanup-lifecycle';

// 5.6 — destructive cleanup is identifier-bound. The production UAT prefix is
// a human label for recognising synthetic rows, never a delete selector.
describe('cleanup lifecycle', () => {
  it('accepts one exact UUID', () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    expect(requireExactCleanupId(id)).toBe(id);
  });

  it.each([
    'E2E-PHASE15-',
    'E2E-PHASE15-*',
    '%PHASE15%',
    '123e4567-e89b-42d3-a456-426614174000,123e4567-e89b-42d3-a456-426614174001',
    '',
  ])('rejects non-exact cleanup selector %s', (value) => {
    expect(() => requireExactCleanupId(value)).toThrow(/exact uuid/i);
  });
});
