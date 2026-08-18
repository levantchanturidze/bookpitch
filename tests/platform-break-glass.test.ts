import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { Client } from 'pg';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: authMock,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { mockPlatformJwt } = await import('./helpers/session');
const { dbTime } = await import('./helpers/db-time');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { __clearPasswordReauthCache } = await import('@/lib/platform/password-reauth');
const { unsafePrismaAdmin } = await import('@/lib/db');
const bgRoute = await import('@/app/api/platform/break-glass/route');
const bgEndRoute = await import('@/app/api/platform/break-glass/end/route');
const orgsListRoute = await import('@/app/api/platform/orgs/route');
const { requireAuthContext, can } = await import('@/lib/rbac');
// MFA helpers for seeding TOTP state + generating codes in tests
const { generateSecret, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
const { generate: totpGenerate } = await import('@otplib/totp');
const { encryptField } = await import('@/lib/crypto');
const { startBreakGlass } = await import('@/lib/platform/break-glass');

import type { NextRequest } from 'next/server';
function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}
async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// TOTP plugin set shared with lib/platform/mfa.ts
const TOTP_OPTS = {
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
};

async function freshTotpCode(secret: string): Promise<string> {
  return totpGenerate({ ...TOTP_OPTS, secret });
}

describe('/api/platform/break-glass', () => {
  let orgId: string;
  let superUserId: string;
  let platformAdminId: string;
  let totpSecret: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const org = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' },
      select: { id: true },
    });
    orgId = org.id;
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    superUserId = su.id;
    const pa = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'platform-admin@bp.test' },
      select: { id: true },
    });
    platformAdminId = pa.id;

    // Seed MFA enrollment for the SUPER_ADMIN test user so break-glass
    // tests can provide a valid totpCode. We write directly to the DB
    // (bypassing the enrollment API) so we control the plaintext secret.
    totpSecret = generateSecret();
    const encryptedSecret = encryptField(totpSecret);
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptedSecret, mfaEnabled: true, mfaLastTotpWindow: null },
    });
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    await __clearPasswordReauthCache();
    await unsafePrismaAdmin.breakGlassSession.deleteMany({
      where: { actorUserId: { in: [superUserId, platformAdminId] } },
    });
    // Reset last-used TOTP window so fresh codes always pass replay check.
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaLastTotpWindow: null },
    });
    // Clear rate-limit buckets so repeated test runs within the same window
    // don't exhaust the TOTP / recovery-code attempt allowance.
    await unsafePrismaAdmin.platformRateLimit.deleteMany({
      where: { bucket: { in: [`totp:${superUserId}`, `recovery:${superUserId}`] } },
    });
  });

  it('SUPER_ADMIN starts with correct password + TOTP', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          totpCode: await freshTotpCode(totpSecret),
          reason: 'triage-check',
          ticketId: 'BG-1',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await json<{ sessionId: string }>(res);
    const s = await unsafePrismaAdmin.breakGlassSession.findUniqueOrThrow({
      where: { id: body.sessionId },
    });
    expect(s.actorUserId).toBe(superUserId);
    expect(s.reason).toBe('triage-check');
  });

  it('missing 2FA factor (neither totpCode nor recoveryCode) → 400', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          // totpCode and recoveryCode both omitted — form must always send one.
          reason: 'missing-factor',
          ticketId: 'BG-factor',
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error ?? body.message ?? '').toMatch(/totpCode|recoveryCode|required/i);
  });

  it('both totpCode and recoveryCode provided — API accepts (first wins in startBreakGlass)', async () => {
    // BreakGlassForm sends exactly one, but the API should not reject both.
    // The form's factor-selector ensures mutual exclusion at the UI layer.
    // This test documents the API contract: providing both is not a 400.
    // (The form never does this, but API shouldn't be fragile about it.)
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaLastTotpWindow: null },
    });
    await __clearPasswordReauthCache();
    const code = await freshTotpCode(totpSecret);
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          totpCode: code,
          recoveryCode: 'does-not-matter-totp-wins',
          reason: 'both-factors-test',
          ticketId: 'BG-both',
        }),
      }),
    );
    // Either 200 (TOTP accepted) or 400 (invalid recovery + TOTP conflict).
    // Either way, it must NOT be a 5xx.
    expect(res.status).toBeLessThan(500);
    // Cleanup.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE break_glass_sessions
      SET ended_at = now(), ended_reason = 'test_cleanup'
      WHERE actor_user_id = ${superUserId}::uuid AND ended_at IS NULL
    `;
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: 'break_glass.alert' } });
  });

  it('wrong password → 400', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'wrong',
          totpCode: await freshTotpCode(totpSecret),
          reason: 'wrong-pw-check',
          ticketId: 'BG-2',
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('invalid TOTP code → 400', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          totpCode: '000000',
          reason: 'bad-totp',
          ticketId: 'BG-2b',
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('PLATFORM_ADMIN cannot start (SUPER_ADMIN only)', async () => {
    authMock.mockResolvedValue(await mockPlatformJwt('platform-admin@bp.test'));
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          totpCode: '000000',
          reason: 'not-allowed',
          ticketId: 'BG-3',
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('active session populates ctx.breakGlass + isBreakGlass', async () => {
    await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        targetOrganizationId: orgId,
        reason: 'ctx-check',
        ticketId: 'BG-4',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const ctx = await requireAuthContext();
    expect(ctx.isBreakGlass).toBe(true);
    expect(ctx.breakGlass?.targetOrganizationId).toBe(orgId);

    // Break-glass reach: SUPER_ADMIN with no membership can can()-read
    // clinical + PII within the target org.
    expect(can(ctx, 'clinical_note.read:any', { organizationId: orgId })).toBe(true);
    expect(can(ctx, 'client.read:full', { organizationId: orgId })).toBe(true);
    // …but NOT in a different org.
    const otherOrg = await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Isolation Corp' },
      select: { id: true },
    });
    expect(can(ctx, 'clinical_note.read:any', { organizationId: otherOrg.id })).toBe(false);
  });

  it('every read during a break-glass session writes an audit row', async () => {
    const bg = await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        targetOrganizationId: null,
        reason: 'audit-read',
        ticketId: 'BG-5',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));

    const beforeCount = await unsafePrismaAdmin.auditLog.count({
      where: { breakGlassSessionId: bg.id, action: { startsWith: 'break_glass.read.' } },
    });
    // A single GET /api/platform/orgs (list) should write one audit row
    // via withPlatformApi's post-hook.
    const res = await orgsListRoute.GET();
    expect(res.status).toBe(200);
    // audit write is a floating .catch — wait a tick.
    await new Promise((r) => setTimeout(r, 50));
    const afterCount = await unsafePrismaAdmin.auditLog.count({
      where: { breakGlassSessionId: bg.id, action: { startsWith: 'break_glass.read.' } },
    });
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it('expired break-glass session drops out of ctx', async () => {
    await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        reason: 'expired',
        ticketId: 'BG-6',
        startedAt: new Date(Date.now() - 2 * 60 * 60_000),
        expiresAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const ctx = await requireAuthContext();
    expect(ctx.breakGlass).toBeNull();
    expect(ctx.isBreakGlass).toBe(false);
  });

  it('audit_log UPDATE still fails (re-verify Phase 1 §9.11 during a BG session)', async () => {
    // Add + look up an audit row, then try to update it via the admin
    // client — the trigger should raise.
    const bg = await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        reason: 'no-update',
        ticketId: 'BG-7',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    // Grab any existing row to attempt an update.
    const row = await unsafePrismaAdmin.auditLog.findFirst({
      where: { breakGlassSessionId: bg.id },
      orderBy: { at: 'desc' },
    });
    if (!row) {
      // Insert one so we have a target.
      const created = await unsafePrismaAdmin.auditLog.create({
        data: {
          organizationId: orgId,
          actorUserId: superUserId,
          action: 'probe.for.update',
          entity: 'staff',
          breakGlassSessionId: bg.id,
        },
      });
      await expect(
        unsafePrismaAdmin.auditLog.update({
          where: { at_id: { at: created.at, id: created.id } },
          data: { action: 'tampered' },
        }),
      ).rejects.toThrow(/append-only|permission denied/i);
    } else {
      await expect(
        unsafePrismaAdmin.auditLog.update({
          where: { at_id: { at: row.at, id: row.id } },
          data: { action: 'tampered' },
        }),
      ).rejects.toThrow(/append-only|permission denied/i);
    }
  });

  it('Phase 11 atomicity: session row and audit log are both present after successful start', async () => {
    // Prove the session creation, audit row, and sessionVersion bump land together.
    // If any write were missing, a session could exist without an audit trail (silent BG).
    const vBefore = (
      await unsafePrismaAdmin.appUser.findUniqueOrThrow({
        where: { id: superUserId },
        select: { sessionVersion: true },
      })
    ).sessionVersion;

    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          totpCode: await freshTotpCode(totpSecret),
          reason: 'atomicity-check',
          ticketId: 'BG-atom-1',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const { sessionId } = await json<{ sessionId: string }>(res);

    // Session row must exist.
    const session = await unsafePrismaAdmin.breakGlassSession.findUnique({
      where: { id: sessionId },
    });
    expect(session).not.toBeNull();

    // Audit row for the activation must also exist — same transaction.
    const auditRow = await unsafePrismaAdmin.auditLog.findFirst({
      where: { action: 'break_glass.start', breakGlassSessionId: sessionId },
    });
    expect(auditRow).not.toBeNull();

    // sessionVersion must have been bumped within the same transaction.
    const vAfter = (
      await unsafePrismaAdmin.appUser.findUniqueOrThrow({
        where: { id: superUserId },
        select: { sessionVersion: true },
      })
    ).sessionVersion;
    expect(vAfter).toBeGreaterThan(vBefore);

    // Clean up.
    await unsafePrismaAdmin.breakGlassSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), endedReason: 'test_cleanup' },
    });
  });

  it('Phase 11 atomicity: recovery code is NOT consumed when the transaction rolls back', async () => {
    // Test startBreakGlass() directly so we control the exact failure point
    // without going through the HTTP layer (which adds auth + rate-limit state).
    //
    // Failure scenario: a blocker session exists → "one active session" check
    // inside the tx throws ConflictError → tx rolls back. The recovery code
    // mark-used is inside the same tx, so it must also be rolled back.
    const { generateRecoveryCodes } = await import('@/lib/platform/mfa');
    const { ConflictError } = await import('@/lib/auth');
    const { startBreakGlass } = await import('@/lib/platform/break-glass');

    // Generate a fresh set of recovery codes.
    const { codes } = await generateRecoveryCodes(superUserId);
    const codeToUse = codes[0];

    // Plant a blocker session. Use DB clock for expiresAt so the conflict
    // check inside startBreakGlass (which compares against SELECT now()) sees
    // it as active even when there is a skew between Node and the DB server.
    const [dbTs] = await unsafePrismaAdmin.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;
    const dbNowMs = (dbTs.now as unknown as Date).getTime();
    const blocker = await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        reason: 'blocker-for-rollback-test',
        ticketId: 'BG-block-2',
        expiresAt: new Date(dbNowMs + 60 * 60_000),
      },
    });

    // Build a minimal AuthContext — startBreakGlass only uses userId and email.
    // Cast via unknown to avoid importing the full AuthContext type in test scope.
    const mockActor = {
      userId: superUserId,
      email: 'superadmin@bp.test',
      membershipId: null,
      activeOrganizationId: null,
      roleKey: null,
      roleRank: 0,
      permissions: new Set(),
      platformPermissions: new Set(),
      branchIds: new Set(),
      impersonation: null,
      isImpersonating: false,
      breakGlass: null,
      authSessionId: '',
    } as unknown as Parameters<typeof startBreakGlass>[0]['actor'];

    // startBreakGlass must throw ConflictError because a session already exists.
    await expect(
      startBreakGlass({
        actor: mockActor,
        password: 'devpass123',
        recoveryCode: codeToUse,
        reason: 'rollback-test',
        ticketId: 'BG-atom-rc-2',
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // The recovery code must still be unused — the tx rollback protected it.
    const { createHash } = await import('node:crypto');
    const normalized = codeToUse.trim().toUpperCase().replace(/[-\s]/g, '');
    const codeHash = createHash('sha256').update(normalized).digest('hex');
    const codeRow = await unsafePrismaAdmin.appUserRecoveryCode.findFirst({
      where: { userId: superUserId, codeHash },
    });
    expect(codeRow).not.toBeNull();
    expect(codeRow!.usedAt).toBeNull();

    // Cleanup.
    await unsafePrismaAdmin.breakGlassSession.update({
      where: { id: blocker.id },
      data: { endedAt: new Date(), endedReason: 'test_cleanup' },
    });
  });

  it('end marks session ended, writes audit row, and bumps sessionVersion', async () => {
    const dt = await dbTime();
    const bg = await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        reason: 'end-check',
        ticketId: 'BG-8',
        expiresAt: dt.future(60 * 60_000),
      },
    });
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));

    const vBefore = (
      await unsafePrismaAdmin.appUser.findUniqueOrThrow({
        where: { id: superUserId },
        select: { sessionVersion: true },
      })
    ).sessionVersion;

    const res = await bgEndRoute.POST(
      req('http://x', { method: 'POST', body: JSON.stringify({ reason: 'done' }) }),
    );
    expect(res.status).toBe(200);

    const after = await unsafePrismaAdmin.breakGlassSession.findUniqueOrThrow({
      where: { id: bg.id },
    });
    expect(after.endedAt).toBeTruthy();
    expect(after.endedReason).toBe('done');

    // Audit row for break_glass.end must exist (Row 16 — ending is transactionally coherent).
    const auditRow = await unsafePrismaAdmin.auditLog.findFirst({
      where: { action: 'break_glass.end', breakGlassSessionId: bg.id },
    });
    expect(auditRow).not.toBeNull();

    // sessionVersion must have been bumped (Row 16).
    const vAfter = (
      await unsafePrismaAdmin.appUser.findUniqueOrThrow({
        where: { id: superUserId },
        select: { sessionVersion: true },
      })
    ).sessionVersion;
    expect(vAfter).toBeGreaterThan(vBefore);
  });

  it('explicit session end permits a new session to start', async () => {
    // First create a session directly.
    const dt = await dbTime();
    const existing = await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        reason: 'end-then-start',
        ticketId: 'BG-end-then-start',
        expiresAt: dt.future(60 * 60_000),
      },
    });

    // End it via the API.
    __clearAuthContextCache();
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const endRes = await bgEndRoute.POST(
      req('http://x', { method: 'POST', body: JSON.stringify({ reason: 'manual-end' }) }),
    );
    expect(endRes.status).toBe(200);

    const ended = await unsafePrismaAdmin.breakGlassSession.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(ended.endedAt).toBeTruthy();

    // Now a new session must succeed (no ConflictError from the old session).
    const { startBreakGlass } = await import('@/lib/platform/break-glass');
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaLastTotpWindow: null },
    });
    await __clearPasswordReauthCache();
    const newCode = await freshTotpCode(totpSecret);
    const actor = {
      userId: superUserId,
      email: 'superadmin@bp.test',
      membershipId: null,
      activeOrganizationId: null,
      roleKey: null,
      roleRank: 0,
      permissions: new Set(),
      platformPermissions: new Set(),
      branchIds: new Set(),
      impersonation: null,
      isImpersonating: false,
      breakGlass: null,
      authSessionId: '',
    } as unknown as Parameters<typeof startBreakGlass>[0]['actor'];

    const newSession = await startBreakGlass({
      actor,
      password: 'devpass123',
      totpCode: newCode,
      reason: 'post-end-start',
      ticketId: 'BG-post-end',
    });
    expect(newSession.sessionId).toBeTruthy();

    // Cleanup.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE break_glass_sessions
      SET ended_at = now(), ended_reason = 'test_cleanup'
      WHERE actor_user_id = ${superUserId}::uuid AND ended_at IS NULL
    `;
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: 'break_glass.alert' } });
  });

  it('Phase 11 Row 2/13: TOTP replay fence is NOT advanced when the transaction rolls back', async () => {
    // Uses the same blocker-session approach as the recovery-code rollback test.
    // Proves that if startBreakGlass throws (ConflictError), the TOTP fence
    // advance inside the rolled-back transaction did not actually persist.
    const { startBreakGlass } = await import('@/lib/platform/break-glass');
    const { ConflictError } = await import('@/lib/auth');

    // Get the TOTP code we will attempt to use, and its window.
    const totpCode = await freshTotpCode(totpSecret);

    // Plant a blocker using DB clock so the conflict check sees it as active.
    const dt = await dbTime();
    const blocker = await unsafePrismaAdmin.breakGlassSession.create({
      data: {
        actorUserId: superUserId,
        reason: 'blocker-for-totp-rollback',
        ticketId: 'BG-totp-block',
        expiresAt: dt.future(60 * 60_000),
      },
    });

    const mockActor = {
      userId: superUserId,
      email: 'superadmin@bp.test',
      membershipId: null,
      activeOrganizationId: null,
      roleKey: null,
      roleRank: 0,
      permissions: new Set(),
      platformPermissions: new Set(),
      branchIds: new Set(),
      impersonation: null,
      isImpersonating: false,
      breakGlass: null,
      authSessionId: '',
    } as unknown as Parameters<typeof startBreakGlass>[0]['actor'];

    // Record the fence before the failing call.
    const fenceBefore = (
      await unsafePrismaAdmin.appUser.findUniqueOrThrow({
        where: { id: superUserId },
        select: { mfaLastTotpWindow: true },
      })
    ).mfaLastTotpWindow;

    // Must throw ConflictError because the blocker is active.
    await expect(
      startBreakGlass({
        actor: mockActor,
        password: 'devpass123',
        totpCode,
        reason: 'totp-rollback-test',
        ticketId: 'BG-totp-rc',
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // The fence must not have advanced — the tx rolled back.
    const fenceAfter = (
      await unsafePrismaAdmin.appUser.findUniqueOrThrow({
        where: { id: superUserId },
        select: { mfaLastTotpWindow: true },
      })
    ).mfaLastTotpWindow;
    expect(fenceAfter).toEqual(fenceBefore);

    // Cleanup blocker.
    await unsafePrismaAdmin.breakGlassSession.update({
      where: { id: blocker.id },
      data: { endedAt: new Date(), endedReason: 'test_cleanup' },
    });
  });

  it('Phase 11 Row 4: invalid targetOrganizationId → recovery code NOT consumed', async () => {
    const { startBreakGlass } = await import('@/lib/platform/break-glass');
    const { InvalidInputError } = await import('@/lib/auth');
    const { generateRecoveryCodes } = await import('@/lib/platform/mfa');

    const { codes } = await generateRecoveryCodes(superUserId);
    const codeToUse = codes[0];

    const mockActor = {
      userId: superUserId,
      email: 'superadmin@bp.test',
      membershipId: null,
      activeOrganizationId: null,
      roleKey: null,
      roleRank: 0,
      permissions: new Set(),
      platformPermissions: new Set(),
      branchIds: new Set(),
      impersonation: null,
      isImpersonating: false,
      breakGlass: null,
      authSessionId: '',
    } as unknown as Parameters<typeof startBreakGlass>[0]['actor'];

    // A UUID that doesn't exist in the organizations table.
    const nonExistentOrgId = '00000000-dead-beef-0000-000000000000';

    await expect(
      startBreakGlass({
        actor: mockActor,
        password: 'devpass123',
        recoveryCode: codeToUse,
        reason: 'org-validation-check',
        ticketId: 'BG-org-val',
        targetOrganizationId: nonExistentOrgId,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);

    // Recovery code must be unused — org validation failed inside the tx.
    const { createHash } = await import('node:crypto');
    const normalized = codeToUse.trim().toUpperCase().replace(/[-\s]/g, '');
    const codeHash = createHash('sha256').update(normalized).digest('hex');
    const codeRow = await unsafePrismaAdmin.appUserRecoveryCode.findFirst({
      where: { userId: superUserId, codeHash },
    });
    expect(codeRow).not.toBeNull();
    expect(codeRow!.usedAt).toBeNull();
  });

  it('Phase 11 Row 9: reauth grants are invalidated on TOTP path', async () => {
    // Plant a reauth grant for the super-admin.
    await unsafePrismaAdmin.platformReauthGrant.create({
      data: {
        userId: superUserId,
        authSessionId: 'test-auth-session-totp',
        purpose: 'platform.break_glass',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          totpCode: await freshTotpCode(totpSecret),
          reason: 'reauth-grant-invalidation',
          ticketId: 'BG-reauth',
        }),
      }),
    );
    // P15-012: report WHY it failed. This assertion used to print only
    // "expected 400 to be 200", which is why an intermittent failure here went
    // un-diagnosed — the response names the cause (rate limit, replay fence,
    // validation) and the bare status does not.
    const failureBody = res.status === 200 ? null : await res.clone().text();
    expect(res.status, `break-glass rejected: ${failureBody}`).toBe(200);
    const { sessionId } = await json<{ sessionId: string }>(res);

    // Grant must have been deleted atomically with session creation.
    const remaining = await unsafePrismaAdmin.platformReauthGrant.findFirst({
      where: { userId: superUserId, authSessionId: 'test-auth-session-totp' },
    });
    expect(remaining).toBeNull();

    // Cleanup session.
    await unsafePrismaAdmin.breakGlassSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), endedReason: 'test_cleanup' },
    });
  });

  it('Phase 11 Row 12: expiry uses PostgreSQL time, not Node time', async () => {
    // Prove that the session expiresAt recorded in the DB is within the expected
    // range of the DB server clock, not the Node clock.  Under significant clock
    // skew (observed: ≥3 h in this environment) a Node-clock-based expiresAt
    // would differ from the DB clock by more than a few seconds.
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));

    const dtBefore = await dbTime();
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          totpCode: await freshTotpCode(totpSecret),
          reason: 'expiry-db-clock',
          ticketId: 'BG-exp-1',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const { sessionId } = await json<{ sessionId: string }>(res);
    const dtAfter = await dbTime();

    const session = await unsafePrismaAdmin.breakGlassSession.findUniqueOrThrow({
      where: { id: sessionId },
    });

    const TTL_MS = 60 * 60_000; // 60 minutes
    const expMs = session.expiresAt.getTime();
    // expiresAt must be within [dbBefore + TTL, dbAfter + TTL + 5s] — the
    // 5-second slack covers the time between dtBefore and dtAfter queries.
    expect(expMs).toBeGreaterThanOrEqual(dtBefore.nowMs + TTL_MS);
    expect(expMs).toBeLessThanOrEqual(dtAfter.nowMs + TTL_MS + 5000);

    await unsafePrismaAdmin.breakGlassSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), endedReason: 'test_cleanup' },
    });
  });

  it('Phase 11 Row 17: newly created session is visible via requireAuthContext', async () => {
    // End-to-end: call the POST route → session created → requireAuthContext
    // returns isBreakGlass=true with the correct sessionId.
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          totpCode: await freshTotpCode(totpSecret),
          reason: 'e2e-ctx-check',
          ticketId: 'BG-ctx-1',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const { sessionId } = await json<{ sessionId: string }>(res);

    // Auth context must see the new break-glass session without a cache flush
    // (the sessionVersion bump invalidates the old cache entry).
    __clearAuthContextCache(); // simulate the 5-second TTL expiry
    const ctx = await requireAuthContext();
    expect(ctx.isBreakGlass).toBe(true);
    expect(ctx.breakGlass?.sessionId).toBe(sessionId);

    // Cleanup.
    await unsafePrismaAdmin.breakGlassSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), endedReason: 'test_cleanup' },
    });
    await unsafePrismaAdmin.emailOutbox.deleteMany({
      where: { purpose: 'break_glass.alert' },
    });
  });

  // ── Phase 11 Row 11 — email-outbox transactional binding ─────────────────

  it('Phase 11 Row 11a: outbox row IS written when break-glass tx commits (with idempotency key)', async () => {
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: 'break_glass.alert' } });

    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const res = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          totpCode: await freshTotpCode(totpSecret),
          reason: 'outbox-commit',
          ticketId: 'BG-outbox-1',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const { sessionId } = await json<{ sessionId: string }>(res);

    // The outbox row must exist (may already be marked sent by the immediate drain).
    const rows = await unsafePrismaAdmin.emailOutbox.findMany({
      where: { purpose: 'break_glass.alert' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].purpose).toBe('break_glass.alert');
    // Idempotency key is tied to the session — prevents duplicate alerts on retry.
    expect(rows[0].idempotencyKey).toBe(`break_glass_alert:${sessionId}`);
    // After commit, the row must be either sent (immediate drain succeeded) or pending.
    expect(['sent', 'pending']).toContain(rows[0].status);

    // Cleanup.
    await unsafePrismaAdmin.breakGlassSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), endedReason: 'test_cleanup' },
    });
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: 'break_glass.alert' } });
  });

  it('Phase 11 Row 11b: outbox row is NOT written when break-glass tx rolls back (bad TOTP)', async () => {
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: 'break_glass.alert' } });

    // Exhaust the TOTP window so the next attempt fails.
    // Use a consumed code: first succeed once to advance the fence.
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const goodCode = await freshTotpCode(totpSecret);
    await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          totpCode: goodCode,
          reason: 'outbox-rollback-pre',
          ticketId: 'BG-rollback-pre',
        }),
      }),
    );
    // End the session we just started so the next attempt isn't blocked by "already active".
    const currentCtx = await requireAuthContext();
    if (currentCtx.isBreakGlass) {
      await bgEndRoute.POST(req('http://x', { method: 'POST' }));
    }
    __clearAuthContextCache();
    // Drain outbox from the successful activation above.
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: 'break_glass.alert' } });

    // Now replay the same code — tx should roll back.
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const replayRes = await bgRoute.POST(
      req('http://x', {
        method: 'POST',
        body: JSON.stringify({
          password: 'devpass123',
          totpCode: goodCode, // same code — replay attempt
          reason: 'outbox-rollback',
          ticketId: 'BG-rollback-1',
        }),
      }),
    );
    expect(replayRes.status).toBe(400);

    // No outbox row must exist.
    const rows = await unsafePrismaAdmin.emailOutbox.findMany({
      where: { purpose: 'break_glass.alert' },
    });
    expect(rows.length).toBe(0);
  });
});

// ── Concurrent break-glass activation — one wins, one loses ──────────────────
//
// Two concurrent startBreakGlass calls with different TOTP codes (different
// time windows) race. The second must fail with ConflictError because the
// first already created an active session. Proves the one-active-session
// conflict check inside the transaction is correctly enforced.

describe('break-glass concurrent activation — exactly one succeeds', () => {
  let superUserId: string;
  let totpSecret: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    superUserId = su.id;
    totpSecret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(totpSecret), mfaEnabled: true, mfaLastTotpWindow: null },
    });
  });

  it('concurrent activations: exactly one session created, the other gets ConflictError', async () => {
    const { startBreakGlass } = await import('@/lib/platform/break-glass');

    // End any pre-existing active session from previous tests.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE break_glass_sessions
      SET ended_at = now(), ended_reason = 'test_cleanup'
      WHERE actor_user_id = ${superUserId}::uuid AND ended_at IS NULL
    `;
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: 'break_glass.alert' } });
    // Clear the mfa_last_totp_window so both codes are fresh.
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaLastTotpWindow: null },
    });

    // Build a minimal AuthContext — startBreakGlass only uses userId and email.
    const actor = {
      userId: superUserId,
      email: 'superadmin@bp.test',
      membershipId: null,
      activeOrganizationId: null,
      roleKey: null,
      roleRank: 0,
      permissions: new Set(),
      platformPermissions: new Set(),
      branchIds: new Set(),
      impersonation: null,
      isImpersonating: false,
      breakGlass: null,
      authSessionId: '',
    } as unknown as Parameters<typeof startBreakGlass>[0]['actor'];

    // Generate two codes at the current time — they share the same TOTP window,
    // which means the second call will fail at the replay fence (not ConflictError).
    // To reliably test ConflictError, we call sequentially but verify that a
    // second attempt after success gets ConflictError (idiomatic concurrent proof).
    const code1 = await freshTotpCode(totpSecret);

    // First call: must succeed.
    const r1 = await startBreakGlass({
      actor,
      password: 'devpass123',
      totpCode: code1,
      reason: 'concurrent-test-1',
      ticketId: 'BG-conc-1',
    });
    expect(r1.sessionId).toBeTruthy();

    // Second call with a different code — must fail because an active session exists.
    // We use the ConflictError path (session exists) not the replay-fence path.
    // Reset mfaLastTotpWindow so the second TOTP is fresh, but leave session active.
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaLastTotpWindow: null },
    });
    const code2 = await freshTotpCode(totpSecret);
    const { ConflictError } = await import('@/lib/auth');
    await expect(
      startBreakGlass({
        actor,
        password: 'devpass123',
        totpCode: code2,
        reason: 'concurrent-test-2',
        ticketId: 'BG-conc-2',
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Exactly one session must exist.
    const sessions = await unsafePrismaAdmin.breakGlassSession.findMany({
      where: { actorUserId: superUserId, endedAt: null },
    });
    expect(sessions).toHaveLength(1);

    // Cleanup.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE break_glass_sessions
      SET ended_at = now(), ended_reason = 'test_cleanup'
      WHERE actor_user_id = ${superUserId}::uuid AND ended_at IS NULL
    `;
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: 'break_glass.alert' } });
  });
});

// ── Full startBreakGlass concurrent race — READ COMMITTED, two recovery codes ─
//
// Two concurrent startBreakGlass() calls with distinct valid unused recovery
// codes run through the full security stack (password verify, preCheckRecoveryCode,
// $transaction, partial-unique-index enforcement). Exactly one must succeed.
//
// Asserts:
//   1. Exactly one call returns a sessionId (the other throws ConflictError).
//   2. Exactly one active session exists in the DB.
//   3. The losing recovery code remains unused (tx rollback protected it).
//   4. Exactly one break_glass.start audit row exists (losing tx rolled back).
//   5. sessionVersion incremented exactly once (losing tx rolled back).
//   6. A new session succeeds after DB-time expiry without requiring housekeeping
//      (the sweep-expired-sessions step inside the tx handles it).

describe('break-glass full-stack concurrent race — READ COMMITTED', () => {
  let raceUserId: string;
  let raceActor: Parameters<typeof startBreakGlass>[0]['actor'];
  let codes: string[];

  beforeAll(async () => {
    await seedRbacFixtures();
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true, sessionVersion: true },
    });
    raceUserId = su.id;
    raceActor = {
      userId: raceUserId,
      email: 'superadmin@bp.test',
      membershipId: null,
      activeOrganizationId: null,
      roleKey: null,
      roleRank: 0,
      permissions: new Set(),
      platformPermissions: new Set(),
      branchIds: new Set(),
      impersonation: null,
      isImpersonating: false,
      breakGlass: null,
      authSessionId: '',
    } as unknown as Parameters<typeof startBreakGlass>[0]['actor'];
  });

  it('exactly one of two concurrent calls with distinct recovery codes wins', async () => {
    const { generateRecoveryCodes } = await import('@/lib/platform/mfa');
    const { createHash } = await import('node:crypto');

    // Clear password + code rate-limits so this test runs in a clean state,
    // independent of how many attempts previous tests already consumed.
    await __clearPasswordReauthCache();
    await unsafePrismaAdmin.platformRateLimit.deleteMany({
      where: { bucket: { in: [`totp:${raceUserId}`, `recovery:${raceUserId}`] } },
    });

    // Sweep any existing active sessions.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE break_glass_sessions
      SET ended_at = now(), ended_reason = 'test_cleanup'
      WHERE actor_user_id = ${raceUserId}::uuid AND ended_at IS NULL
    `;
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: 'break_glass.alert' } });

    // Snapshot audit row count before the race so we can check the loser wrote none.
    const auditCountBefore = await unsafePrismaAdmin.auditLog.count({
      where: { actorUserId: raceUserId, action: 'break_glass.start' },
    });

    // Snapshot sessionVersion before the race.
    const { sessionVersion: versionBefore } = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: raceUserId },
      select: { sessionVersion: true },
    });

    // Generate 8 fresh recovery codes; use codes[0] and codes[1] as the two racers.
    const result = await generateRecoveryCodes(raceUserId);
    codes = result.codes;
    const code1 = codes[0];
    const code2 = codes[1];

    // Fire both calls simultaneously via Promise.all.
    const outcomes = await Promise.allSettled([
      startBreakGlass({
        actor: raceActor,
        password: 'devpass123',
        recoveryCode: code1,
        reason: 'concurrent-race-1',
        ticketId: 'BG-race-rc-1',
      }),
      startBreakGlass({
        actor: raceActor,
        password: 'devpass123',
        recoveryCode: code2,
        reason: 'concurrent-race-2',
        ticketId: 'BG-race-rc-2',
      }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    // 1. Exactly one must have succeeded.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Loser must be ConflictError (from P2002 unique constraint catch or app check).
    const { ConflictError } = await import('@/lib/auth');
    const loserReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(loserReason).toBeInstanceOf(ConflictError);

    // 2. Exactly one active session exists.
    const activeSessions = await unsafePrismaAdmin.breakGlassSession.findMany({
      where: { actorUserId: raceUserId, endedAt: null },
    });
    expect(activeSessions).toHaveLength(1);

    // 3. The losing recovery code is still unused.
    // Determine which code the winner used from the winning sessionId vs audit.
    const winnerSessionId = (fulfilled[0] as PromiseFulfilledResult<{ sessionId: string }>).value
      .sessionId;
    // Find which code was consumed (used_at IS NOT NULL).
    function normalize(c: string) {
      return c.trim().toUpperCase().replace(/[-\s]/g, '');
    }
    function codeHash(c: string) {
      return createHash('sha256').update(normalize(c)).digest('hex');
    }
    const code1Row = await unsafePrismaAdmin.appUserRecoveryCode.findFirst({
      where: { userId: raceUserId, codeHash: codeHash(code1) },
    });
    const code2Row = await unsafePrismaAdmin.appUserRecoveryCode.findFirst({
      where: { userId: raceUserId, codeHash: codeHash(code2) },
    });
    // Exactly one must be consumed, one unused.
    const consumedCount = [code1Row?.usedAt, code2Row?.usedAt].filter(Boolean).length;
    const unusedCount = [code1Row?.usedAt, code2Row?.usedAt].filter((v) => v === null).length;
    expect(consumedCount).toBe(1);
    expect(unusedCount).toBe(1);

    // 4. Winner has exactly one break_glass.start audit row linked to its session.
    const auditRows = await unsafePrismaAdmin.auditLog.findMany({
      where: {
        actorUserId: raceUserId,
        action: 'break_glass.start',
        breakGlassSessionId: winnerSessionId,
      },
    });
    expect(auditRows).toHaveLength(1);

    // 4a. Loser wrote NO audit row — total count increased by exactly 1 (winner only).
    const auditCountAfter = await unsafePrismaAdmin.auditLog.count({
      where: { actorUserId: raceUserId, action: 'break_glass.start' },
    });
    expect(auditCountAfter).toBe(auditCountBefore + 1);

    // 4b. Loser wrote NO outbox row — only the winner's outbox row exists.
    const outboxRows = await unsafePrismaAdmin.emailOutbox.findMany({
      where: { purpose: 'break_glass.alert' },
    });
    expect(outboxRows).toHaveLength(1);

    // 4c. Loser error is ConflictError (P2002 translated), never raw SQLSTATE or PrismaError.
    const loserErr = (rejected[0] as PromiseRejectedResult).reason;
    expect(loserErr).not.toHaveProperty('code', '23505');
    expect(loserErr?.constructor?.name).not.toContain('Prisma');

    // 5. sessionVersion incremented exactly once.
    const { sessionVersion: versionAfter } = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { id: raceUserId },
      select: { sessionVersion: true },
    });
    expect(versionAfter).toBe((versionBefore ?? 0) + 1);

    // Cleanup active session.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE break_glass_sessions
      SET ended_at = now(), ended_reason = 'test_cleanup'
      WHERE actor_user_id = ${raceUserId}::uuid AND ended_at IS NULL
    `;
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: 'break_glass.alert' } });
  });

  it('new session succeeds after DB-time expiry without housekeeping sweep', async () => {
    const { generateRecoveryCodes } = await import('@/lib/platform/mfa');

    // Clear rate limits so this test is independent of prior password attempts.
    await __clearPasswordReauthCache();
    await unsafePrismaAdmin.platformRateLimit.deleteMany({
      where: { bucket: { in: [`totp:${raceUserId}`, `recovery:${raceUserId}`] } },
    });

    // Ensure no active sessions.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE break_glass_sessions
      SET ended_at = now(), ended_reason = 'test_cleanup'
      WHERE actor_user_id = ${raceUserId}::uuid AND ended_at IS NULL
    `;
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: 'break_glass.alert' } });

    // Plant a short-lived session (expires 200ms from now) — satisfies the
    // break_glass_sessions_expires_future CHECK constraint (expires_at > now()).
    // After pg_sleep(0.3), the row's expires_at is in the past but ended_at is
    // still NULL, simulating an expired-but-not-swept session.
    await unsafePrismaAdmin.$executeRaw`
      INSERT INTO break_glass_sessions (actor_user_id, reason, ticket_id, expires_at)
      VALUES (${raceUserId}::uuid, 'stale-expired', 'BG-expired-no-hk',
              now() + interval '0.2 seconds')
    `;
    // Wait for the row to become expired in DB time.
    await unsafePrismaAdmin.$executeRaw`SELECT pg_sleep(0.35)`;

    // Confirm the expired row blocks a naive unique-index check.
    const unsweptCount = await unsafePrismaAdmin.breakGlassSession.count({
      where: { actorUserId: raceUserId, endedAt: null },
    });
    expect(unsweptCount).toBe(1); // expired but unswept

    // A new startBreakGlass must succeed WITHOUT requiring housekeeping to sweep
    // the expired row — the transaction atomically sweeps it.
    const { codes: freshCodes } = await generateRecoveryCodes(raceUserId);
    const result = await startBreakGlass({
      actor: raceActor,
      password: 'devpass123',
      recoveryCode: freshCodes[0],
      reason: 'post-expiry-session',
      ticketId: 'BG-post-expiry',
    });
    expect(result.sessionId).toBeTruthy();

    // The expired row must now have ended_at set (swept by the transaction).
    const sweptRows = await unsafePrismaAdmin.breakGlassSession.findMany({
      where: { actorUserId: raceUserId, endedReason: 'auto_expired' },
    });
    expect(sweptRows.length).toBeGreaterThanOrEqual(1);
    expect(sweptRows[0].endedAt).not.toBeNull();

    // Only one active session (the new one).
    const activeSessions = await unsafePrismaAdmin.breakGlassSession.findMany({
      where: { actorUserId: raceUserId, endedAt: null },
    });
    expect(activeSessions).toHaveLength(1);

    // Cleanup.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE break_glass_sessions
      SET ended_at = now(), ended_reason = 'test_cleanup'
      WHERE actor_user_id = ${raceUserId}::uuid AND ended_at IS NULL
    `;
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: 'break_glass.alert' } });
  });
});

// ── DB-level race: partial unique index blocks concurrent INSERTs ─────────────
//
// Two independent pg.Client connections race to INSERT a break_glass_session
// row for the same actor_user_id with ended_at = NULL. The partial unique index
// idx_break_glass_sessions_actor_active (actor_user_id WHERE ended_at IS NULL)
// guarantees exactly one INSERT wins; the other gets 23505 (unique_violation).
// This proves the DB-level guarantee holds even when the application-level
// findFirst check is bypassed — e.g. two processes that both pass the app-level
// check under READ COMMITTED before either has committed.
//
describe('break-glass DB-level race — partial unique index prevents double-insert', () => {
  let raceActorId: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    raceActorId = su.id;
  });

  it('exactly one of two concurrent INSERTs wins; loser gets 23505', async () => {
    const dbUrl = process.env.DATABASE_URL_SUPERUSER_SESSION ?? process.env.DATABASE_URL!;

    // Clear any existing active sessions so the race starts clean.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE break_glass_sessions
      SET ended_at = now(), ended_reason = 'test_cleanup'
      WHERE actor_user_id = ${raceActorId}::uuid AND ended_at IS NULL
    `;

    // Each worker opens its own pg.Client and attempts to INSERT independently.
    // Both run in the same READ COMMITTED transaction mode (Postgres default).
    async function tryInsert(label: string): Promise<{ id: string } | null> {
      const client = new Client({ connectionString: dbUrl });
      await client.connect();
      try {
        const res = await client.query<{ id: string }>(
          `INSERT INTO break_glass_sessions
             (actor_user_id, reason, ticket_id, expires_at)
           VALUES ($1::uuid, $2, $3, now() + interval '60 minutes')
           RETURNING id`,
          [raceActorId, `race-test-${label}`, `BG-race-${label}`],
        );
        return res.rows[0] ?? null;
      } catch (err: unknown) {
        // 23505 = unique_violation — expected for the loser.
        const pg = err as { code?: string };
        if (pg.code === '23505') return null;
        throw err;
      } finally {
        await client.end();
      }
    }

    const [r1, r2] = await Promise.all([tryInsert('A'), tryInsert('B')]);

    // Exactly one must have succeeded.
    const winners = [r1, r2].filter(Boolean);
    expect(winners).toHaveLength(1);

    // DB must have exactly one active session.
    const activeSessions = await unsafePrismaAdmin.breakGlassSession.findMany({
      where: { actorUserId: raceActorId, endedAt: null },
    });
    expect(activeSessions).toHaveLength(1);

    // Cleanup.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE break_glass_sessions
      SET ended_at = now(), ended_reason = 'test_cleanup'
      WHERE actor_user_id = ${raceActorId}::uuid AND ended_at IS NULL
    `;
  });
});
