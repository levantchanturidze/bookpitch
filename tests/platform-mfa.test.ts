import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { mockPlatformJwt } = await import('./helpers/session');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { unsafePrismaAdmin } = await import('@/lib/db');
const { generateTotpEnrollment, confirmTotpEnrollment, verifyTotp } = await import('@/lib/platform/mfa');
const { encryptField } = await import('@/lib/crypto');
const { InvalidInputError } = await import('@/lib/auth');
const enrollRoute  = await import('@/app/api/platform/mfa/enroll/route');
const confirmRoute = await import('@/app/api/platform/mfa/confirm/route');

// Use same TOTP plugin set as lib/platform/mfa.ts
const { generateSecret, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
const { generate: totpGenerate } = await import('@otplib/totp');
const TOTP_OPTS = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };

import type { NextRequest } from 'next/server';
function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}
async function json<T = unknown>(res: Response): Promise<T> { return (await res.json()) as T; }
async function freshCode(secret: string) { return totpGenerate({ ...TOTP_OPTS, secret }); }

describe('platform MFA (F2 — TOTP enrollment + verification)', () => {
  let superUserId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' }, select: { id: true },
    });
    superUserId = su.id;
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    // Clear TOTP rate-limit buckets so consecutive tests don't trip the limit.
    await unsafePrismaAdmin.platformRateLimit.deleteMany({
      where: { bucket: { startsWith: 'totp:' } },
    }).catch(() => {});
    // Reset MFA state to a known enrolled state with a controlled secret.
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: true, mfaLastTotpWindow: null },
    });
    return { secret };
  });

  // ── Enrollment API ─────────────────────────────────────────────────────────

  it('SUPER_ADMIN can start enrollment (POST /api/platform/mfa/enroll)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await enrollRoute.POST();
    expect(res.status).toBe(200);
    const body = await json<{ secret: string; otpauthUri: string }>(res);
    expect(body.secret).toBeTruthy();
    expect(body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    // DB should have the encrypted secret and mfaEnabled=false (pending).
    const u = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId }, select: { mfaTotp: true, mfaEnabled: true },
    });
    expect(u.mfaTotp).toBeTruthy();
    expect(u.mfaEnabled).toBe(false);
  });

  it('non-SUPER_ADMIN cannot enroll (403)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await enrollRoute.POST();
    expect(res.status).toBe(403);
  });

  // ── Confirm enrollment ─────────────────────────────────────────────────────

  it('correct first code confirms enrollment and enables MFA', async () => {
    // Start enrollment to get a fresh pending secret.
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: false, mfaLastTotpWindow: null },
    });

    await confirmTotpEnrollment(superUserId, await freshCode(secret));
    const u = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId }, select: { mfaEnabled: true },
    });
    expect(u.mfaEnabled).toBe(true);
  });

  it('wrong code on confirmation throws InvalidInputError', async () => {
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: false, mfaLastTotpWindow: null },
    });
    await expect(confirmTotpEnrollment(superUserId, '000000')).rejects.toBeInstanceOf(InvalidInputError);
    // MFA remains disabled.
    const u = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId }, select: { mfaEnabled: true },
    });
    expect(u.mfaEnabled).toBe(false);
  });

  it('confirm route returns 400 for wrong code', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: false, mfaLastTotpWindow: null },
    });
    const res = await confirmRoute.POST(req('http://x', {
      method: 'POST', body: JSON.stringify({ code: '000000' }),
    }));
    expect(res.status).toBe(400);
  });

  // ── verifyTotp — break-glass path ──────────────────────────────────────────

  it('valid code passes verifyTotp and advances last-used window', async () => {
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: true, mfaLastTotpWindow: null },
    });
    await expect(verifyTotp(superUserId, await freshCode(secret))).resolves.toBeUndefined();
    const u = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId }, select: { mfaLastTotpWindow: true },
    });
    expect(u.mfaLastTotpWindow).not.toBeNull();
  });

  it('reused code is rejected (replay protection)', async () => {
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: true, mfaLastTotpWindow: null },
    });
    const code = await freshCode(secret);
    await verifyTotp(superUserId, code);
    // Second use of the same code in the same 30s window must fail.
    await expect(verifyTotp(superUserId, code)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('invalid code throws InvalidInputError', async () => {
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: true, mfaLastTotpWindow: null },
    });
    await expect(verifyTotp(superUserId, '000000')).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('verifyTotp throws when MFA not enrolled (mfaEnabled=false)', async () => {
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaEnabled: false, mfaTotp: null },
    });
    await expect(verifyTotp(superUserId, '123456')).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('break-glass without MFA enrolled returns 400 (not 403)', async () => {
    // Proves the guard at startBreakGlass, not just the route-level field check.
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaEnabled: false, mfaTotp: null },
    });
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const bgRoute = await import('@/app/api/platform/break-glass/route');
    const res = await bgRoute.POST(req('http://x', {
      method: 'POST',
      body: JSON.stringify({
        password: 'devpass123', totpCode: '000000',
        reason: 'no-mfa-test', ticketId: 'BG-mfa-1',
      }),
    }));
    expect(res.status).toBe(400);
  });
});
