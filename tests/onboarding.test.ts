import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { onboardOrg } = await import('@/lib/onboarding');
const { InvalidInputError } = await import('@/lib/auth');

const created: { userId?: string; orgId?: string } = {};

describe('onboardOrg — self-service org creation', () => {
  const email = `onboard-${Date.now()}@example.dev`;

  afterAll(async () => {
    await withoutRls(async (tx) => {
      if (created.userId) {
        await tx.membership.deleteMany({ where: { userId: created.userId } });
        await tx.appUser.delete({ where: { id: created.userId } });
      }
      if (created.orgId) await tx.organization.delete({ where: { id: created.orgId } });
    });
  });

  it('creates user + org + location + owner membership in one call', async () => {
    const res = await onboardOrg({
      email,
      password: 'longenoughpass1',
      fullName: 'Test Owner',
      orgName: 'Test Clinic Group',
      locationName: 'Downtown',
      locationType: 'salon',
    });
    created.userId = res.userId;
    created.orgId = res.organizationId;

    const org = await withoutRls((tx) =>
      tx.organization.findUnique({ where: { id: res.organizationId } }),
    );
    expect(org?.name).toBe('Test Clinic Group');

    const location = await withoutRls((tx) =>
      tx.location.findUnique({ where: { id: res.locationId } }),
    );
    expect(location?.type).toBe('salon');
    expect(location?.name).toBe('Downtown');

    const membership = await withoutRls((tx) =>
      tx.membership.findFirst({ where: { userId: res.userId } }),
    );
    expect(membership?.role).toBe('owner');
    expect(membership?.organizationId).toBe(res.organizationId);
  });

  it('rejects a second onboard with the same email', async () => {
    await expect(
      onboardOrg({
        email,
        password: 'anotherpassword1',
        fullName: 'Someone Else',
        orgName: 'Different Org',
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it.each([
    { email: '', password: 'x'.repeat(12), fullName: 'Y', orgName: 'Z' },
    { email: 'x@y.z', password: 'short', fullName: 'Y', orgName: 'Z' },
    { email: 'x@y.z', password: 'longpass1234', fullName: '', orgName: 'Z' },
    { email: 'x@y.z', password: 'longpass1234', fullName: 'Y', orgName: '' },
  ])('rejects invalid input: %o', async (input) => {
    await expect(onboardOrg(input as Parameters<typeof onboardOrg>[0])).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });
});
