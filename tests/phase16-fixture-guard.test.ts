import { describe, it, expect, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin } = await import('@/lib/db');
const { __findUndefinedFilter } = await import('./setup');

// -----------------------------------------------------------------------------
// The teardown hazard this guards: Prisma drops undefined filter values, so
// deleteMany({ where: { id: undefined } }) becomes deleteMany({}) and matches
// every row. Any teardown running after a failed beforeAll reaches that state,
// and the pattern appears in 34 test files.
//
// These assertions use a table nothing else touches in anger and never actually
// delete anything — the guard throws first, which is the whole point.
// -----------------------------------------------------------------------------

describe('fixture guard · an undefined filter cannot widen a bulk write', () => {
  it('detects undefined at the top level', () => {
    expect(__findUndefinedFilter({ id: undefined })).toBe('where.id');
    expect(__findUndefinedFilter({ organizationId: undefined })).toBe('where.organizationId');
  });

  it('detects undefined nested one level down', () => {
    expect(__findUndefinedFilter({ id: { in: undefined } })).toBe('where.id.in');
  });

  it('accepts filters that are actually specified', () => {
    expect(__findUndefinedFilter({ id: 'abc' })).toBeNull();
    expect(__findUndefinedFilter({ id: { in: ['a', 'b'] } })).toBeNull();
    expect(__findUndefinedFilter({ status: null })).toBeNull(); // null is a real filter
  });

  // Thrown synchronously, before any query is built — the call never becomes a
  // promise, so this is `expect(fn).toThrow`, not `.rejects`.
  it('deleteMany with an undefined id throws instead of matching every row', () => {
    const undefinedId: string | undefined = undefined;
    expect(() => unsafePrismaAdmin.notification.deleteMany({ where: { id: undefinedId } })).toThrow(
      /fixture guard/i,
    );
  });

  it('updateMany with an undefined id throws too', () => {
    const undefinedId: string | undefined = undefined;
    expect(() =>
      unsafePrismaAdmin.notification.updateMany({
        where: { id: undefinedId },
        data: { read: true },
      }),
    ).toThrow(/fixture guard/i);
  });

  it('names the offending path so the fix is obvious', () => {
    const undefinedId: string | undefined = undefined;
    expect(() => unsafePrismaAdmin.notification.deleteMany({ where: { id: undefinedId } })).toThrow(
      /where\.id = undefined/,
    );
  });

  // Complement: a real, narrow delete must still work, or the guard would have
  // broken every teardown in the suite rather than protecting them.
  it('a specified filter still runs', async () => {
    const res = await unsafePrismaAdmin.notification.deleteMany({
      where: { id: '00000000-0000-4000-8000-0000000000fe' },
    });
    expect(res.count).toBe(0);
  });
});
