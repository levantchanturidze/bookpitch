import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { requestPasswordReset, consumeReset } = await import('@/lib/auth/password-reset');
const { InvalidInputError } = await import('@/lib/auth');

describe('password reset — request + consume + session-version bump', () => {
  const email = `reset-test-${Date.now()}@example.dev`;
  let userId: string;
  let orgId: string;

  beforeAll(async () => {
    const { org, user } = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `pw-reset-${Date.now()}` } });
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: email,
          email,
          fullName: 'Reset Tester',
          passwordHash: 'ignored-hash',
        },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: user.id, role: 'owner' },
      });
      return { org, user };
    });
    orgId = org.id;
    userId = user.id;
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.verificationToken.deleteMany({ where: { identifier: email } });
      await tx.membership.deleteMany({ where: { userId } });
      await tx.appUser.delete({ where: { id: userId } });
      await tx.organization.delete({ where: { id: orgId } });
    });
  });

  beforeEach(async () => {
    await withoutRls((tx) => tx.verificationToken.deleteMany({ where: { identifier: email } }));
  });

  it('requestPasswordReset stores a hashed token — never the raw one', async () => {
    await requestPasswordReset({ email });
    const row = await withoutRls((tx) =>
      tx.verificationToken.findFirst({ where: { identifier: email } }),
    );
    expect(row).toBeTruthy();
    // Token is a 64-char sha256 hex, not a 43-char base64url.
    expect(row!.token).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.expires.getTime()).toBeGreaterThan(Date.now());
  });

  it('unknown email is a silent no-op — never throws, never enumerates', async () => {
    await expect(requestPasswordReset({ email: 'nobody@nowhere.dev' })).resolves.toBeUndefined();
    const rows = await withoutRls((tx) =>
      tx.verificationToken.findMany({ where: { identifier: 'nobody@nowhere.dev' } }),
    );
    expect(rows.length).toBe(0);
  });

  it('rejects malformed email', async () => {
    await expect(requestPasswordReset({ email: '' })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(requestPasswordReset({ email: 'no-at-sign' })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it('consumeReset accepts the raw token, updates password, bumps sessionVersion', async () => {
    // Plant a known token by writing directly (bypassing the email step).
    const raw = 'known-raw-token-for-testing-1234567890';
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    await withoutRls((tx) =>
      tx.verificationToken.create({
        data: {
          identifier: email,
          token: tokenHash,
          expires: new Date(Date.now() + 60_000),
        },
      }),
    );

    const before = await withoutRls((tx) =>
      tx.appUser.findUnique({ where: { id: userId }, select: { sessionVersion: true } }),
    );

    const res = await consumeReset({ token: raw, newPassword: 'brand-new-pass-987' });
    expect(res.userId).toBe(userId);

    const after = await withoutRls((tx) =>
      tx.appUser.findUnique({
        where: { id: userId },
        select: { sessionVersion: true, passwordHash: true },
      }),
    );
    expect(after!.sessionVersion).toBe((before!.sessionVersion ?? 1) + 1);
    // Password hash was replaced (starts with the argon2 prefix).
    expect(after!.passwordHash).toMatch(/^\$argon2/);

    // Token is single-use — a second consume with the same token fails.
    await expect(
      consumeReset({ token: raw, newPassword: 'another-pass-1234' }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('rejects expired tokens', async () => {
    const raw = 'expired-token-1234567890';
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    await withoutRls((tx) =>
      tx.verificationToken.create({
        data: {
          identifier: email,
          token: tokenHash,
          expires: new Date(Date.now() - 60_000),
        },
      }),
    );
    await expect(consumeReset({ token: raw, newPassword: 'x'.repeat(12) })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it('rejects short passwords', async () => {
    await expect(
      consumeReset({ token: 'anything-long-enough-here', newPassword: 'short' }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});
