import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { createInvitation, acceptInvitation, revokeInvitation } = await import(
  '@/lib/invitations'
);
const { InvalidInputError } = await import('@/lib/auth');

describe('invitations — create, accept, revoke', () => {
  let orgId: string;
  let ownerId: string;
  const createdIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `inv-${Date.now()}` } });
      const owner = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: `inv-owner-${Date.now()}@ex.dev`,
          email: `inv-owner-${Date.now()}@ex.dev`,
          fullName: 'Inv Owner',
          passwordHash: 'x',
        },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: owner.id, role: 'owner' },
      });
      return { org, owner };
    });
    orgId = seed.org.id;
    ownerId = seed.owner.id;
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.invitation.deleteMany({ where: { organizationId: orgId } });
      await tx.membership.deleteMany({ where: { organizationId: orgId } });
      for (const uid of createdUserIds) await tx.appUser.delete({ where: { id: uid } });
      await tx.appUser.delete({ where: { id: ownerId } });
      await tx.organization.delete({ where: { id: orgId } });
    });
  });

  function session(role: 'owner' | 'practitioner' | 'receptionist' = 'owner') {
    return {
      userId: ownerId,
      organizationId: orgId,
      role,
      email: 'inv@example.dev',
    } as const;
  }

  function tokenFromUrl(url: string): string {
    return decodeURIComponent(new URL(url).searchParams.get('token') ?? '');
  }

  it('createInvitation rejects non-owner callers', async () => {
    await expect(
      createInvitation(session('receptionist'), { email: 'x@y.dev', role: 'practitioner' }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('createInvitation stores a hashed token; email is normalized to lowercase', async () => {
    const res = await createInvitation(session(), {
      email: 'NEW.STAFF@Example.DEV',
      role: 'practitioner',
    });
    createdIds.push(res.id);
    const row = await withoutRls((tx) => tx.invitation.findUnique({ where: { id: res.id } }));
    expect(row?.email).toBe('new.staff@example.dev');
    expect(row?.role).toBe('practitioner');
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.status).toBe('pending');
  });

  it('a second pending invite for the same email in the same org is rejected', async () => {
    await expect(
      createInvitation(session(), {
        email: 'new.staff@example.dev',
        role: 'practitioner',
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('acceptInvitation creates a new user + membership; second accept fails', async () => {
    const res = await createInvitation(session(), {
      email: `accept-${Date.now()}@example.dev`,
      role: 'receptionist',
    });
    createdIds.push(res.id);
    const token = tokenFromUrl(res.url);

    const accepted = await acceptInvitation({
      token,
      password: 'joinpass1234',
      fullName: 'Joined Staff',
    });
    createdUserIds.push(accepted.userId);
    expect(accepted.organizationId).toBe(orgId);
    expect(accepted.role).toBe('receptionist');

    const membership = await withoutRls((tx) =>
      tx.membership.findFirst({ where: { organizationId: orgId, userId: accepted.userId } }),
    );
    expect(membership?.role).toBe('receptionist');

    // Second accept — invitation is now "accepted"
    await expect(
      acceptInvitation({ token, password: 'joinpass1234', fullName: 'x' }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('acceptInvitation links an EXISTING account without touching the password', async () => {
    const email = `existing-${Date.now()}@example.dev`;
    const existingUser = await withoutRls((tx) =>
      tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: email,
          email,
          fullName: 'Pre-existing',
          passwordHash: 'PRESERVE-ME',
        },
      }),
    );
    createdUserIds.push(existingUser.id);

    const res = await createInvitation(session(), { email, role: 'practitioner' });
    createdIds.push(res.id);
    const accepted = await acceptInvitation({ token: tokenFromUrl(res.url) });
    expect(accepted.userId).toBe(existingUser.id);
    expect(accepted.role).toBe('practitioner');

    const after = await withoutRls((tx) =>
      tx.appUser.findUnique({ where: { id: existingUser.id }, select: { passwordHash: true } }),
    );
    expect(after?.passwordHash).toBe('PRESERVE-ME');
  });

  it('revokeInvitation flips status and blocks further accepts', async () => {
    const res = await createInvitation(session(), {
      email: `revoke-${Date.now()}@example.dev`,
      role: 'practitioner',
    });
    createdIds.push(res.id);
    await revokeInvitation(session(), res.id);
    const row = await withoutRls((tx) => tx.invitation.findUnique({ where: { id: res.id } }));
    expect(row?.status).toBe('revoked');
    await expect(
      acceptInvitation({ token: tokenFromUrl(res.url), password: 'x'.repeat(12) }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});
