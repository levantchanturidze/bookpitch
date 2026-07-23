import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const cookieStore = new Map<string, string>();

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined,
    set: (name: string, value: string) => cookieStore.set(name, value),
    delete: (name: string) => cookieStore.delete(name),
  }),
}));

const { withoutRls } = await import('@/lib/db');
const { listUserMemberships, switchActiveOrg, resolveActiveOrg } = await import(
  '@/lib/org-switch'
);
const { InvalidInputError } = await import('@/lib/auth');

describe('org switcher', () => {
  let orgA: string;
  let orgB: string;
  let orgUnrelated: string;
  let userId: string;

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const oA = await tx.organization.create({ data: { name: `swA-${Date.now()}` } });
      const oB = await tx.organization.create({ data: { name: `swB-${Date.now()}` } });
      const oU = await tx.organization.create({ data: { name: `swU-${Date.now()}` } });
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `sw-${Date.now()}@ex.dev`,
          email: `sw-${Date.now()}@ex.dev`,
          fullName: 'Switcher',
          passwordHash: 'x',
        },
      });
      await tx.membership.createMany({
        data: [
          { organizationId: oA.id, userId: user.id, role: 'owner' },
          { organizationId: oB.id, userId: user.id, role: 'practitioner' },
        ],
      });
      return { oA, oB, oU, user };
    });
    orgA = seed.oA.id;
    orgB = seed.oB.id;
    orgUnrelated = seed.oU.id;
    userId = seed.user.id;
  });

  afterAll(async () => {
    cookieStore.clear();
    await withoutRls(async (tx) => {
      await tx.membership.deleteMany({ where: { userId } });
      await tx.appUser.delete({ where: { id: userId } });
      await tx.organization.deleteMany({
        where: { id: { in: [orgA, orgB, orgUnrelated] } },
      });
    });
  });

  it('lists both memberships in join order', async () => {
    const ms = await listUserMemberships(userId);
    expect(ms.length).toBe(2);
    expect(ms.map((m) => m.role).sort()).toEqual(['owner', 'practitioner']);
  });

  it('switchActiveOrg refuses an org the user is not a member of', async () => {
    await expect(switchActiveOrg(userId, orgUnrelated)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    expect(cookieStore.get('bp_active_org')).toBeUndefined();
  });

  it('switchActiveOrg sets the cookie for a valid membership', async () => {
    await switchActiveOrg(userId, orgB);
    expect(cookieStore.get('bp_active_org')).toBe(orgB);
  });

  it('resolveActiveOrg prefers the cookie org and adjusts role', async () => {
    cookieStore.set('bp_active_org', orgB);
    const resolved = await resolveActiveOrg({
      userId,
      organizationId: orgA,
      role: 'owner',
      email: 'x@y.z',
    });
    expect(resolved.organizationId).toBe(orgB);
    expect(resolved.role).toBe('practitioner');
  });

  it('resolveActiveOrg falls back to JWT org when the cookie is stale', async () => {
    cookieStore.set('bp_active_org', orgUnrelated);
    const resolved = await resolveActiveOrg({
      userId,
      organizationId: orgA,
      role: 'owner',
      email: 'x@y.z',
    });
    expect(resolved.organizationId).toBe(orgA);
    expect(resolved.role).toBe('owner');
  });
});
