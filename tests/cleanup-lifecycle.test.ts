import { describe, expect, it, vi } from 'vitest';

// lib/cleanup-lifecycle imports @/lib/auth, which reaches next-auth, and
// next-auth's env shim resolves 'next/server' in a way vitest cannot follow
// unless @/auth is mocked BEFORE the module graph is pulled in. Every other
// database-backed suite here does the same thing; this file statically
// imported the module instead, so it failed to load at all in CI while passing
// nothing — a red suite that never ran an assertion.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { requireExactCleanupId } = await import('@/lib/cleanup-lifecycle');

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
