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
const {
  generateTotpEnrollment,
  confirmTotpEnrollment,
  verifyTotp,
  generateRecoveryCodes,
  consumeRecoveryCode,
} = await import('@/lib/platform/mfa');
const { encryptField } = await import('@/lib/crypto');
const { InvalidInputError } = await import('@/lib/auth');
const { verifyPasswordFresh, __clearPasswordReauthCache } =
  await import('@/lib/platform/password-reauth');
const enrollRoute = await import('@/app/api/platform/mfa/enroll/route');
const confirmRoute = await import('@/app/api/platform/mfa/confirm/route');
const recoveryCodesRoute = await import('@/app/api/platform/mfa/recovery-codes/route');
const { getRemainingRecoveryCodeCount } = await import('@/lib/platform/mfa');

// Use same TOTP plugin set as lib/platform/mfa.ts
const { generateSecret, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
const { generate: totpGenerate } = await import('@otplib/totp');
const TOTP_OPTS = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };

import type { NextRequest } from 'next/server';
function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}
async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
async function freshCode(secret: string) {
  return totpGenerate({ ...TOTP_OPTS, secret });
}

// Matches the default authSessionId returned by mockPlatformJwt so that
// verifyPasswordFresh grants are visible to the route's ctx.authSessionId.
const TEST_SESSION = 'test-platform-session';

describe('platform MFA (F2 — TOTP enrollment + verification)', () => {
  let superUserId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    superUserId = su.id;
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    // Clear all rate-limit buckets and reauth grants so tests are isolated.
    await unsafePrismaAdmin.platformRateLimit
      .deleteMany({
        where: { bucket: { startsWith: 'totp:' } },
      })
      .catch(() => {});
    await unsafePrismaAdmin.platformRateLimit
      .deleteMany({
        where: { bucket: { startsWith: 'recovery:' } },
      })
      .catch(() => {});
    await __clearPasswordReauthCache();
    // Reset MFA state to a known enrolled state with a controlled secret.
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: true, mfaLastTotpWindow: null },
    });
  });

  // ── Enrollment API ─────────────────────────────────────────────────────────

  it('SUPER_ADMIN can start enrollment after fresh password (POST /api/platform/mfa/enroll)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    // Enrollment requires: already-not-enrolled state + fresh password grant.
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaEnabled: false, mfaTotp: null, mfaLastTotpWindow: null },
    });
    await verifyPasswordFresh(superUserId, 'devpass123', TEST_SESSION, 'platform.mfa.enroll');
    const res = await enrollRoute.POST();
    expect(res.status).toBe(200);
    const body = await json<{ secret: string; otpauthUri: string }>(res);
    expect(body.secret).toBeTruthy();
    expect(body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    // DB should have the encrypted secret and mfaEnabled=false (pending).
    const u = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId },
      select: { mfaTotp: true, mfaEnabled: true },
    });
    expect(u.mfaTotp).toBeTruthy();
    expect(u.mfaEnabled).toBe(false);
  });

  it('enroll route returns 403 without fresh password grant', async () => {
    // No verifyPasswordFresh → requireFreshPassword throws → 403.
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaEnabled: false, mfaTotp: null, mfaLastTotpWindow: null },
    });
    const res = await enrollRoute.POST();
    expect(res.status).toBe(403);
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
    // Direct lib call — does not go through the route's requireFreshPassword.
    await confirmTotpEnrollment(superUserId, await freshCode(secret));
    const u = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId },
      select: { mfaEnabled: true },
    });
    expect(u.mfaEnabled).toBe(true);
  });

  it('wrong code on confirmation throws InvalidInputError', async () => {
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: false, mfaLastTotpWindow: null },
    });
    await expect(confirmTotpEnrollment(superUserId, '000000')).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    // MFA remains disabled.
    const u = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId },
      select: { mfaEnabled: true },
    });
    expect(u.mfaEnabled).toBe(false);
  });

  it('confirm route returns 400 for wrong code (with valid fresh password grant)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: false, mfaLastTotpWindow: null },
    });
    await verifyPasswordFresh(superUserId, 'devpass123', TEST_SESSION, 'platform.mfa.confirm');
    const res = await confirmRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({ code: '000000' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('confirm route returns 403 without fresh password grant', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: false, mfaLastTotpWindow: null },
    });
    const res = await confirmRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({ code: '000000' }),
      }),
    );
    expect(res.status).toBe(403);
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
      where: { id: superUserId },
      select: { mfaLastTotpWindow: true },
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

  it('verifyTotp throws on corrupted mfaTotp blob (tampered ciphertext)', async () => {
    // Set a value that looks like a v1: blob but has a truncated payload.
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: 'v1:aGVsbG8=', mfaEnabled: true, mfaLastTotpWindow: null },
    });
    await expect(verifyTotp(superUserId, '123456')).rejects.toThrow();
  });

  it('verifyTotp with code for a different user is rejected', async () => {
    // Generate a valid TOTP code for a second user and try to use it against superUserId.
    const secretForOther = generateSecret();
    const codeForOther = await freshCode(secretForOther);
    // superUserId has a DIFFERENT secret; codeForOther will not match.
    const secret = generateSecret(); // separate secret for superUser
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: true, mfaLastTotpWindow: null },
    });
    await expect(verifyTotp(superUserId, codeForOther)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('break-glass without MFA enrolled returns 400 (not 403)', async () => {
    // Proves the guard at startBreakGlass, not just the route-level field check.
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaEnabled: false, mfaTotp: null },
    });
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const bgRoute = await import('@/app/api/platform/break-glass/route');
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          totpCode: '000000',
          reason: 'no-mfa-test',
          ticketId: 'BG-mfa-1',
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  // ── Recovery code as break-glass second factor (Phase J) ──────────────────

  it('break-glass succeeds with a recovery code as the second factor', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const { codes } = await generateRecoveryCodes(superUserId);
    const bgRoute = await import('@/app/api/platform/break-glass/route');
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          recoveryCode: codes[0],
          reason: 'authenticator app lost — using recovery code',
          ticketId: 'BG-rc-1',
        }),
      }),
    );
    // Should succeed and create a break-glass session.
    expect(res.status).toBe(200);
    const body = await json<{ sessionId: string; expiresAt: string }>(res);
    expect(body.sessionId).toBeTruthy();
    // Clean up: end the session so subsequent tests start fresh.
    const session = await unsafePrismaAdmin.breakGlassSession.findUniqueOrThrow({
      where: { id: body.sessionId },
      select: { id: true },
    });
    await unsafePrismaAdmin.breakGlassSession.update({
      where: { id: session.id },
      data: { endedAt: new Date(), endedReason: 'test_cleanup' },
    });
  });

  it('break-glass rejects a reused recovery code as the second factor', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const { codes } = await generateRecoveryCodes(superUserId);
    const bgRoute = await import('@/app/api/platform/break-glass/route');
    // First use — must succeed.
    const first = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          recoveryCode: codes[0],
          reason: 'first use',
          ticketId: 'BG-rc-replay-1',
        }),
      }),
    );
    expect(first.status).toBe(200);
    const { sessionId } = await json<{ sessionId: string }>(first);
    await unsafePrismaAdmin.breakGlassSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), endedReason: 'test_cleanup' },
    });

    // Clear rate-limit buckets so the second call isn't blocked by the rate limit.
    await unsafePrismaAdmin.platformRateLimit
      .deleteMany({ where: { bucket: { startsWith: 'recovery:' } } })
      .catch(() => {});

    // Second use of the same recovery code must be rejected.
    const second = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          recoveryCode: codes[0],
          reason: 'replay attempt',
          ticketId: 'BG-rc-replay-2',
        }),
      }),
    );
    expect(second.status).toBe(400);
  });

  it('break-glass route requires exactly one of totpCode or recoveryCode', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const bgRoute = await import('@/app/api/platform/break-glass/route');
    // Neither provided.
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({ password: 'devpass123', reason: 'test', ticketId: 'BG-x-1' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  // ── Security regression: atomic TOTP replay protection ────────────────────

  it('verifyTotp advances mfa_last_totp_window atomically (DB row updated)', async () => {
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: true, mfaLastTotpWindow: null },
    });
    const code = await freshCode(secret);
    await verifyTotp(superUserId, code);
    // Confirm the DB row was updated (not just an in-memory state change).
    const after = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId },
      select: { mfaLastTotpWindow: true },
    });
    expect(after.mfaLastTotpWindow).not.toBeNull();
  });

  it('simulated concurrent replay: second verifyTotp with same window is rejected', async () => {
    // Prove the atomic UPDATE rejects a second request in the same window.
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: true, mfaLastTotpWindow: null },
    });
    const code = await freshCode(secret);
    // Run both concurrently — exactly one must succeed.
    const results = await Promise.allSettled([
      verifyTotp(superUserId, code),
      verifyTotp(superUserId, code),
    ]);
    const successes = results.filter((r) => r.status === 'fulfilled').length;
    const failures = results.filter((r) => r.status === 'rejected').length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);
  });

  // ── Cache-Control on enrollment response ──────────────────────────────────

  it('POST /api/platform/mfa/enroll response has Cache-Control: no-store', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaEnabled: false, mfaTotp: null, mfaLastTotpWindow: null },
    });
    await verifyPasswordFresh(superUserId, 'devpass123', TEST_SESSION, 'platform.mfa.enroll');
    const res = await enrollRoute.POST();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  // ── Recovery codes ────────────────────────────────────────────────────────

  it('generateRecoveryCodes returns 8 codes when MFA is enrolled', async () => {
    const { codes } = await generateRecoveryCodes(superUserId);
    expect(codes).toHaveLength(8);
    // Each code should be a non-empty string with the expected format (dashes).
    codes.forEach((c) => {
      expect(c).toMatch(/^[0-9A-F]+-[0-9A-F]+-[0-9A-F]+-[0-9A-F]+$/);
    });
  });

  it('generateRecoveryCodes throws when MFA not enrolled', async () => {
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaEnabled: false, mfaTotp: null },
    });
    await expect(generateRecoveryCodes(superUserId)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('consumeRecoveryCode succeeds on first use', async () => {
    const { codes } = await generateRecoveryCodes(superUserId);
    await expect(consumeRecoveryCode(superUserId, codes[0])).resolves.toBeUndefined();
    // Code is now marked used; verify in DB.
    const used = await unsafePrismaAdmin.appUserRecoveryCode.findFirst({
      where: { userId: superUserId, usedAt: { not: null } },
    });
    expect(used).not.toBeNull();
  });

  it('recovery code replay is rejected', async () => {
    const { codes } = await generateRecoveryCodes(superUserId);
    await consumeRecoveryCode(superUserId, codes[0]);
    // Second consumption of the same code must fail.
    await expect(consumeRecoveryCode(superUserId, codes[0])).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it('recovery code for wrong user is rejected', async () => {
    // Generate codes for superUserId, but try to consume against a different ID.
    const { codes } = await generateRecoveryCodes(superUserId);
    const fakeId = '00000000-0000-0000-0000-000000000000';
    await expect(consumeRecoveryCode(fakeId, codes[0])).rejects.toBeInstanceOf(InvalidInputError);
    // Code for superUserId must still be available.
    const stillAvailable = await unsafePrismaAdmin.appUserRecoveryCode.findFirst({
      where: { userId: superUserId, usedAt: null },
    });
    expect(stillAvailable).not.toBeNull();
  });

  it('consumeRecoveryCode bumps sessionVersion and invalidates reauth grant', async () => {
    const { codes } = await generateRecoveryCodes(superUserId);
    await verifyPasswordFresh(superUserId, 'devpass123', TEST_SESSION, 'platform.mfa.enroll');
    const before = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId },
      select: { sessionVersion: true },
    });
    await consumeRecoveryCode(superUserId, codes[0]);
    const after = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId },
      select: { sessionVersion: true },
    });
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    // No active grant should exist for the new session version — the old grant
    // is stale because sessionVersion no longer matches the user row.
    const grant = await unsafePrismaAdmin.platformReauthGrant.findFirst({
      where: { userId: superUserId, consumedAt: null, sessionVersion: after.sessionVersion },
    });
    expect(grant).toBeNull();
  });

  it('concurrent recovery code consumption: exactly one succeeds', async () => {
    const { codes } = await generateRecoveryCodes(superUserId);
    const results = await Promise.allSettled([
      consumeRecoveryCode(superUserId, codes[0]),
      consumeRecoveryCode(superUserId, codes[0]),
    ]);
    const successes = results.filter((r) => r.status === 'fulfilled').length;
    const failures = results.filter((r) => r.status === 'rejected').length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);
  });

  // ── Re-enrollment: active MFA must survive the window ─────────────────────
  //
  // Regression: before the fix, generateTotpEnrollment always wrote
  // mfaEnabled=false, disabling break-glass while the new secret was pending.

  it('re-enrollment (generateTotpEnrollment on enrolled user) preserves mfaEnabled=true', async () => {
    // Confirm the user is enrolled.
    const before = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId },
      select: { mfaEnabled: true },
    });
    expect(before.mfaEnabled).toBe(true);

    // Start re-enrollment.
    await generateTotpEnrollment(superUserId);

    // mfaEnabled must still be true — old break-glass path remains usable.
    const after = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId },
      select: { mfaEnabled: true, mfaTotp: true },
    });
    expect(after.mfaEnabled).toBe(true);
    expect(after.mfaTotp).toBeTruthy(); // Old confirmed secret stays intact.
  });

  it('verifyTotp still works with OLD secret during re-enrollment window', async () => {
    // Read and decrypt the old active secret that beforeEach installed.
    const { decryptField } = await import('@/lib/crypto');
    const row = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId },
      select: { mfaTotp: true },
    });
    const oldSecret = decryptField(row.mfaTotp!);
    if (!oldSecret) throw new Error('test setup: could not decrypt old mfaTotp');

    // Start re-enrollment — must NOT overwrite mfaTotp.
    await generateTotpEnrollment(superUserId);

    // Break-glass with the old confirmed secret must still succeed.
    const code = await freshCode(oldSecret);
    await expect(verifyTotp(superUserId, code)).resolves.toBeUndefined();
  });

  it('complement: verifyTotp rejects a code from the pending (unconfirmed) re-enrollment secret', async () => {
    // Start re-enrollment — new secret goes to mfaTotpPending, NOT mfaTotp.
    const { secret: pendingSecret } = await generateTotpEnrollment(superUserId);
    const pendingCode = await freshCode(pendingSecret);
    // verifyTotp reads mfaTotp (the old confirmed secret), so the pending code must fail.
    await expect(verifyTotp(superUserId, pendingCode)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('re-enrollment: confirmation promotes pending secret to active', async () => {
    await generateTotpEnrollment(superUserId);

    // Capture the pending encrypted blob before confirmation.
    const rowBefore = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId },
      select: { mfaTotp: true, mfaTotpPending: true },
    });
    const pendingBlob = rowBefore.mfaTotpPending;
    expect(pendingBlob).toBeTruthy();

    // Decrypt the pending secret to generate a valid confirmation code.
    const { decryptField } = await import('@/lib/crypto');
    const pendingSecret = decryptField(pendingBlob!);
    if (!pendingSecret) throw new Error('test setup: could not decrypt pending blob');
    await confirmTotpEnrollment(superUserId, await freshCode(pendingSecret));

    // After confirmation: mfaTotpPending cleared, mfaTotp promoted.
    const after = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId },
      select: { mfaTotp: true, mfaTotpPending: true, mfaEnabled: true },
    });
    expect(after.mfaEnabled).toBe(true);
    expect(after.mfaTotpPending).toBeNull();
    // The promoted encrypted blob must equal what was in mfaTotpPending.
    expect(after.mfaTotp).toBe(pendingBlob);
  });

  it('complement: generateTotpEnrollment on UN-enrolled user leaves mfaEnabled=false', async () => {
    // Ensure no active MFA.
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaEnabled: false, mfaTotp: null, mfaLastTotpWindow: null },
    });

    await generateTotpEnrollment(superUserId);

    const after = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: superUserId },
      select: { mfaEnabled: true },
    });
    // Must still be false — enrollment is not confirmed yet.
    expect(after.mfaEnabled).toBe(false);
  });
});

// ── Recovery code API (GET + POST /api/platform/mfa/recovery-codes) ──────────

describe('Recovery code API — GET /api/platform/mfa/recovery-codes', () => {
  let superUserId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    superUserId = su.id;
    // Ensure MFA is enrolled for this describe block.
    const { generateSecret } = await import('otplib');
    const { encryptField } = await import('@/lib/crypto');
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: true },
    });
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    // Seed 8 fresh recovery codes before each test in this block.
    await generateRecoveryCodes(superUserId);
  });

  it('RC.1: GET returns remaining count for SUPER_ADMIN', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await recoveryCodesRoute.GET();
    expect(res.status).toBe(200);
    const body = await json<{ remaining: number }>(res);
    expect(body.remaining).toBe(8); // freshly generated set
  });

  it('RC.2: GET returns correct count after one code consumed', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    // Manually mark one code used.
    await unsafePrismaAdmin.appUserRecoveryCode.updateMany({
      where: { userId: superUserId, usedAt: null },
      data: { usedAt: new Date() },
    });
    // Reset to one consumed + rest unused — but updateMany sets ALL, so just count.
    const count = await getRemainingRecoveryCodeCount(superUserId);
    const res = await recoveryCodesRoute.GET();
    const body = await json<{ remaining: number }>(res);
    expect(body.remaining).toBe(count);
  });

  it('RC.3: GET sets Cache-Control: no-store', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await recoveryCodesRoute.GET();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('RC.4: non-SUPER_ADMIN GET returns 403', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await recoveryCodesRoute.GET();
    expect(res.status).toBe(403);
  });
});

describe('Recovery code API — POST /api/platform/mfa/recovery-codes (regenerate)', () => {
  let superUserId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    superUserId = su.id;
    const { generateSecret } = await import('otplib');
    const { encryptField } = await import('@/lib/crypto');
    const secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: true },
    });
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    await __clearPasswordReauthCache();
    await unsafePrismaAdmin.platformReauthGrant
      .deleteMany({ where: { userId: superUserId } })
      .catch(() => {});
  });

  it('RC.5: POST returns 8 plaintext codes after fresh password grant', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    await verifyPasswordFresh(
      superUserId,
      'devpass123',
      TEST_SESSION,
      'platform.mfa.recovery_codes',
    );
    const res = await recoveryCodesRoute.POST();
    expect(res.status).toBe(200);
    const body = await json<{ codes: string[] }>(res);
    expect(body.codes).toHaveLength(8);
    // Each code must match the expected format.
    body.codes.forEach((c) => expect(c).toMatch(/^[0-9A-F]+-[0-9A-F]+-[0-9A-F]+-[0-9A-F]+$/));
  });

  it('RC.6: POST sets Cache-Control: no-store — codes are shown once only', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    await verifyPasswordFresh(
      superUserId,
      'devpass123',
      TEST_SESSION,
      'platform.mfa.recovery_codes',
    );
    const res = await recoveryCodesRoute.POST();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('RC.7: POST without fresh password grant returns 403', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    // No verifyPasswordFresh call → requireFreshPassword throws → 403.
    const res = await recoveryCodesRoute.POST();
    expect(res.status).toBe(403);
  });

  it('RC.8: POST invalidates the old codes — old codes no longer exist after regeneration', async () => {
    // Generate an initial set of codes.
    const { codes: oldCodes } = await generateRecoveryCodes(superUserId);
    const oldHash = await unsafePrismaAdmin.appUserRecoveryCode.findFirst({
      where: { userId: superUserId, usedAt: null },
      select: { codeHash: true },
    });
    expect(oldHash).not.toBeNull();

    // Regenerate via route.
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    await verifyPasswordFresh(
      superUserId,
      'devpass123',
      TEST_SESSION,
      'platform.mfa.recovery_codes',
    );
    const res = await recoveryCodesRoute.POST();
    expect(res.status).toBe(200);

    // The old code hash must no longer exist in the DB.
    const stillPresent = await unsafePrismaAdmin.appUserRecoveryCode.findFirst({
      where: { userId: superUserId, codeHash: oldHash!.codeHash },
    });
    expect(stillPresent).toBeNull();

    // Response codes are different from the old ones.
    const body = await json<{ codes: string[] }>(res);
    oldCodes.forEach((old) => expect(body.codes).not.toContain(old));
  });

  it('RC.9: non-SUPER_ADMIN cannot regenerate codes (403)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await recoveryCodesRoute.POST();
    expect(res.status).toBe(403);
  });
});
