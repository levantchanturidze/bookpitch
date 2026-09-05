import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({ auth: authMock, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));

const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { mockPlatformJwt } = await import('./helpers/session');
const { unsafePrismaAdmin } = await import('@/lib/db');
const { __clearAuthContextCache } = await import('@/lib/rbac/context');
const { __clearPasswordReauthCache } = await import('@/lib/platform/password-reauth');
const bgRoute = await import('@/app/api/platform/break-glass/route');
const { generateSecret } = await import('otplib');
const { generate: totpGenerate } = await import('@otplib/totp');
const { encryptField } = await import('@/lib/crypto');
const {
  TOTP_OPTS,
  TOTP_STEP_MS,
  MIN_HEADROOM_MS,
  stepRemainingMs,
  waitMsForHeadroom,
  freshTotpCode,
} = await import('./helpers/totp');

import type { NextRequest } from 'next/server';
const req = (url: string, init?: RequestInit) => new Request(url, init) as unknown as NextRequest;

// -----------------------------------------------------------------------------
// A TOTP code is accepted ONLY inside the step it was minted in.
//
// This test exists because of CI run 33962683939 — the push build on merge
// commit `9cc6582`:
//
//   FAIL tests/platform-break-glass.test.ts:114
//        SUPER_ADMIN starts with correct password + TOTP
//   AssertionError: expected 400 to be 200
//
// The response landed at 11:14:00.045Z after 111ms, so the request started
// ~66ms before a 30-second boundary and was verified after it. The code was
// genuinely expired by the time it arrived. The application was right; the test
// was racing the clock, and `tests/helpers/totp.ts` now removes that race.
//
// THE POINT OF THIS FILE is the other half. The cheapest way to make that flake
// disappear is to widen the verifier's acceptance, and this otplib spells that
// `epochTolerance`. Its own documentation recommends `30` as "standard" for 2FA
// and `[5, 0]` as RFC-compliant. Either would have turned the failed run green.
//
// Either would also extend how long a shoulder-surfed or intercepted code stays
// usable, on the endpoint that grants SUPER_ADMIN access to client PII and
// clinical records (spec §7.2). That is buying test convenience with
// authentication strength.
//
// So the strictness is asserted here, against the real endpoint at pinned
// instants, and the assertions are calibrated against both settings:
//
//   epochTolerance: [5, 0]   -> the CI-failure test below goes green (bad)
//   epochTolerance: 30       -> that one plus both full-step tests go green
//
// Measured by applying each to lib/platform/mfa.ts and re-running, not assumed.
// -----------------------------------------------------------------------------

/** A real step boundary: a multiple of 30_000 ms since the epoch. */
const BOUNDARY = 1788606840000;

describe('a TOTP code is refused outside the step that minted it', () => {
  let superUserId: string;
  let secret: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    superUserId = su.id;
    secret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaTotp: encryptField(secret), mfaEnabled: true, mfaLastTotpWindow: null },
    });
  });

  beforeEach(async () => {
    authMock.mockReset();
    __clearAuthContextCache();
    await __clearPasswordReauthCache();
    await unsafePrismaAdmin.breakGlassSession.deleteMany({ where: { actorUserId: superUserId } });
    await unsafePrismaAdmin.appUser.update({
      where: { id: superUserId },
      data: { mfaLastTotpWindow: null },
    });
    await unsafePrismaAdmin.platformRateLimit.deleteMany({
      where: { bucket: { in: [`totp:${superUserId}`, `recovery:${superUserId}`] } },
    });
  });

  /**
   * Mint at `genAtMs` and verify at `verifyAtMs`, both pinned.
   *
   * Only `Date.now` is replaced, and only across these two calls — otplib reads
   * the clock through it, and the surrounding database work does not depend on
   * it. Restored in a finally so a failure cannot leak a frozen clock into the
   * next test.
   */
  async function attemptAcross(genAtMs: number, verifyAtMs: number) {
    authMock.mockResolvedValue(await mockPlatformJwt('superadmin@bp.test'));
    const realNow = Date.now;
    let code: string;
    try {
      Date.now = () => genAtMs;
      code = await totpGenerate({ ...TOTP_OPTS, secret });
    } finally {
      Date.now = realNow;
    }
    const body = JSON.stringify({
      password: 'devpass123',
      totpCode: code,
      reason: 'step-boundary',
      ticketId: 'BG-step',
    });
    try {
      Date.now = () => verifyAtMs;
      const res = await bgRoute.POST(req('http://x', { method: 'POST', body }));
      return { status: res.status, body: (await res.json()) as { error?: string } };
    } finally {
      Date.now = realNow;
    }
  }

  it('THE CI FAILURE, reproduced: minted 100ms before a boundary, verified 45ms after', async () => {
    const r = await attemptAcross(BOUNDARY - 100, BOUNDARY + 45);
    expect(r.status, 'a code from the previous step must not be accepted').toBe(400);
    expect(r.body.error).toMatch(/invalid or expired TOTP code/);
  });

  it('COMPLEMENT: the identical request wholly inside one step succeeds', async () => {
    // Without this, "always return 400" would satisfy the test above.
    const r = await attemptAcross(BOUNDARY + 5_000, BOUNDARY + 5_111);
    expect(r.status, 'a code inside its own step must be accepted').toBe(200);
  });

  it('the PREVIOUS step is refused — tolerance is zero, not one period', async () => {
    // Blocks `epochTolerance: 30`, which otplib's docs call "standard" for 2FA.
    // A code minted one step early is exactly what that setting lets through.
    const r = await attemptAcross(BOUNDARY - TOTP_STEP_MS + 5_000, BOUNDARY + 5_000);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid or expired TOTP code/);
  });

  it('a code minted one step in the FUTURE is refused', async () => {
    // The other side. A symmetric tolerance accepts both directions, so this
    // catches `epochTolerance: 30` even if the past-side test were softened.
    const r = await attemptAcross(BOUNDARY + TOTP_STEP_MS + 5_000, BOUNDARY + 5_000);
    expect(r.status).toBe(400);
  });

  it('a code stays valid across the whole step it belongs to', async () => {
    // The boundary is what expires a code, not elapsed time since minting: a
    // code made at the top of a step is still good 29s later, inside it.
    const r = await attemptAcross(BOUNDARY + 10, BOUNDARY + 29_000);
    expect(r.status).toBe(200);
  });
});

// -----------------------------------------------------------------------------
// The helper's own contract. It is what every other TOTP test now depends on.
// -----------------------------------------------------------------------------
describe('the test helper mints codes with validity left', () => {
  let waitUserId: string;
  let waitSecret: string;

  beforeAll(async () => {
    await seedRbacFixtures();
    const su = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
      where: { email: 'superadmin@bp.test' },
      select: { id: true },
    });
    waitUserId = su.id;
    waitSecret = generateSecret();
    await unsafePrismaAdmin.appUser.update({
      where: { id: waitUserId },
      data: { mfaTotp: encryptField(waitSecret), mfaEnabled: true, mfaLastTotpWindow: null },
    });
  });

  it('always leaves at least the minimum headroom', async () => {
    const realNow = Date.now;
    try {
      // Pin to 50ms before a boundary — the shape that broke CI. The helper
      // must not mint here; it must wait for the next step.
      Date.now = () => BOUNDARY - 50;
      expect(stepRemainingMs()).toBe(50);
      expect(stepRemainingMs()).toBeLessThan(MIN_HEADROOM_MS);
    } finally {
      Date.now = realNow;
    }
  });

  it('reports the remaining step time correctly at known instants', () => {
    expect(stepRemainingMs(BOUNDARY)).toBe(TOTP_STEP_MS);
    expect(stepRemainingMs(BOUNDARY + 1)).toBe(TOTP_STEP_MS - 1);
    expect(stepRemainingMs(BOUNDARY - 1)).toBe(1);
  });

  it('REAL CLOCK: a minted code has headroom, whenever this runs', async () => {
    // Not pinned — this is the property that matters in CI, exercised against
    // whatever instant the suite happens to reach.
    const secret = generateSecret();
    await freshTotpCode(secret);
    expect(
      stepRemainingMs(),
      'the helper returned inside a step that was about to end',
    ).toBeGreaterThanOrEqual(MIN_HEADROOM_MS - 100);
  });

  it('THE WAIT PATH: it waits when the step is nearly over', () => {
    // The branch that fixes the flake. Checked at pinned instants rather than
    // by sitting through a real wait: the decision is a pure function of the
    // clock, and the sleep it drives is one setTimeout.
    expect(waitMsForHeadroom(MIN_HEADROOM_MS, BOUNDARY - 50), 'must wait past the boundary').toBe(
      70,
    );
    expect(waitMsForHeadroom(MIN_HEADROOM_MS, BOUNDARY - 1)).toBe(21);
    expect(waitMsForHeadroom(MIN_HEADROOM_MS, BOUNDARY - MIN_HEADROOM_MS + 1)).toBe(
      MIN_HEADROOM_MS - 1 + 20,
    );
  });

  it('COMPLEMENT: it does NOT wait when the step has room', () => {
    // Without this, "always wait a full step" would satisfy the test above and
    // add 30 seconds to every TOTP test in the suite.
    expect(waitMsForHeadroom(MIN_HEADROOM_MS, BOUNDARY)).toBe(0);
    expect(waitMsForHeadroom(MIN_HEADROOM_MS, BOUNDARY + 1_000)).toBe(0);
    expect(waitMsForHeadroom(MIN_HEADROOM_MS, BOUNDARY - MIN_HEADROOM_MS)).toBe(0);
  });

  it('the wait always lands inside the NEXT step, never on its edge', () => {
    // Off-by-one guard: minting exactly on a boundary is the failure being
    // fixed, so the wait must overshoot it.
    for (const offset of [1, 50, 500, MIN_HEADROOM_MS - 1]) {
      const at = BOUNDARY - offset;
      const wait = waitMsForHeadroom(MIN_HEADROOM_MS, at);
      expect(wait, `offset ${offset}`).toBeGreaterThan(offset);
      expect(stepRemainingMs(at + wait), `offset ${offset}`).toBeGreaterThan(
        TOTP_STEP_MS - MIN_HEADROOM_MS,
      );
    }
  });

  it('no verify() call site softens the tolerance', async () => {
    // A source check, and it took two attempts to make it mean anything.
    //
    // The first version asserted the source contained no `window:`. That string
    // can never appear — this otplib exposes the setting as `epochTolerance`,
    // not `window` — so the check passed unconditionally and "caught" a
    // perturbation only because the perturbation injected that literal word. It
    // was documentation that compiled.
    //
    // `epochTolerance` is the real lever, and it is measured: setting
    // `[5, 0]` makes the CI-failure test above pass (a 145ms overrun is inside
    // 5s), and setting `30` makes three of them pass. Those tests are the
    // primary guard. This one covers the call sites in this module that no test
    // currently drives, where a silent widening would otherwise go unseen.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('lib/platform/mfa.ts', 'utf8');
    const calls = src.match(/verify\(\{[^}]*\}\)/g) ?? [];
    expect(calls.length, 'expected the verify() call sites to be found').toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, 'a verify() call must not widen epochTolerance').not.toMatch(/epochTolerance/);
    }
  });
});
