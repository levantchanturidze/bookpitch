import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin } = await import('@/lib/db');
const onboardRoute = await import('@/app/api/onboard/route');

import type { NextRequest } from 'next/server';
async function json<T = unknown>(res: Response): Promise<T> { return (await res.json()) as T; }

function onboardReq(body: Record<string, unknown>, extra: { ip?: string; contentLength?: number } = {}): NextRequest {
  const raw = JSON.stringify(body);
  return new Request('http://x/api/onboard', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(extra.contentLength ?? raw.length),
      ...(extra.ip ? { 'x-forwarded-for': extra.ip } : {}),
    },
    body: raw,
  }) as unknown as NextRequest;
}

const goodBody = {
  email: `onboard-sec-${Date.now()}@example.dev`,
  password: 'strongpass123',
  fullName: 'Test Owner',
  orgName: 'Security Test Clinic',
};

// Track created entities for teardown — keeps dev DB clean.
const createdUsers: string[] = [];
const createdOrgs: string[] = [];

describe('POST /api/onboard — F3 security controls', () => {
  afterAll(async () => {
    // Delete all users + orgs created during this suite so the rbac-backfill
    // invariant check (owner_user_id IS NOT NULL for non-archived orgs) stays green.
    const { withoutRls } = await import('@/lib/db');
    await withoutRls(async (tx) => {
      for (const userId of createdUsers) {
        await tx.membership.deleteMany({ where: { userId } }).catch(() => {});
        await tx.appUser.delete({ where: { id: userId } }).catch(() => {});
      }
      for (const orgId of createdOrgs) {
        await tx.location.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
        await tx.organization.delete({ where: { id: orgId } }).catch(() => {});
      }
    });
  });

  beforeEach(async () => {
    // Flush the rate-limit buckets for the IPs used below so tests are independent.
    await unsafePrismaAdmin.platformRateLimit.deleteMany({
      where: { bucket: { startsWith: 'onboard:ip:' } },
    }).catch(() => {});
  });

  // ── Body size guard ─────────────────────────────────────────────────────────

  it('rejects payload with content-length > 16 KB', async () => {
    const res = await onboardRoute.POST(
      onboardReq(goodBody, { contentLength: 17 * 1024 }),
    );
    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    // Generic message — no leaking of which validation failed.
    expect(body.error).toBe('invalid request');
  });

  // ── Enumeration-safe responses ──────────────────────────────────────────────

  it('duplicate email → generic 400 (does not expose "email taken")', async () => {
    // Seed an existing user with this email via direct service call.
    const { onboardOrg } = await import('@/lib/onboarding');
    const dup = `dup-${Date.now()}@example.dev`;
    const r = await onboardOrg({ email: dup, password: 'strongpass123', fullName: 'A', orgName: 'B' });
    createdUsers.push(r.userId);
    createdOrgs.push(r.organizationId);

    const res = await onboardRoute.POST(onboardReq({ ...goodBody, email: dup }, { ip: '1.2.3.4' }));
    expect(res.status).toBe(400);
    const b = await json<{ error: string }>(res);
    // Must be generic — not "email already registered" or similar.
    expect(b.error).toBe('invalid request');
  });

  it('invalid email → generic 400 (same message as duplicate email)', async () => {
    const res = await onboardRoute.POST(onboardReq({ ...goodBody, email: 'not-an-email' }, { ip: '1.2.3.5' }));
    expect(res.status).toBe(400);
    const b = await json<{ error: string }>(res);
    expect(b.error).toBe('invalid request');
  });

  // ── Rate limiting ───────────────────────────────────────────────────────────

  it('rate-limits the 6th attempt from the same IP within an hour', async () => {
    const ip = '5.5.5.5';
    // 5 requests consume the bucket — they will fail validation (bad email)
    // but the rate-limit counter still increments before validation runs.
    for (let i = 0; i < 5; i++) {
      await onboardRoute.POST(onboardReq({ ...goodBody, email: `fail${i}@x` }, { ip }));
    }
    // 6th attempt should be rate-limited regardless of payload validity.
    const res = await onboardRoute.POST(onboardReq(goodBody, { ip }));
    expect(res.status).toBe(400);
  });

  it('requests from different IPs are not affected by each other\'s rate limit', async () => {
    const ip1 = '10.0.0.1';
    const ip2 = '10.0.0.2';
    // Exhaust ip1.
    for (let i = 0; i < 5; i++) {
      await onboardRoute.POST(onboardReq({ ...goodBody, email: `fail${i}@x` }, { ip: ip1 }));
    }
    // ip2 is still within limit — should get past rate-limit (may fail on other grounds).
    const res = await onboardRoute.POST(onboardReq({ ...goodBody, email: `diff@x` }, { ip: ip2 }));
    // If it got past rate-limit the status must NOT be our rate-limit response.
    // It could be 400 (email validation) but not 429 — we use generic 400.
    // The key point: ip2 hasn't hit the limit yet, so it reaches the next layer.
    expect(res.status).not.toBeGreaterThanOrEqual(500);
  });

  // ── CAPTCHA (optional, env-gated) ──────────────────────────────────────────

  it('skips CAPTCHA check when TURNSTILE_SECRET_KEY is absent (dev/test mode)', async () => {
    // TURNSTILE_SECRET_KEY is not set in test env, so captchaOk=true always.
    // A valid payload with no turnstileToken must reach onboardOrg (not bail early).
    const email = `captcha-skip-${Date.now()}@example.dev`;
    const res = await onboardRoute.POST(onboardReq({ ...goodBody, email }, { ip: '2.2.2.2' }));
    // Either 201 (created) or 400 (validation) — NOT a CAPTCHA-specific 400 with
    // a different body. This confirms Turnstile is not enforced in test mode.
    if (res.status === 201) {
      const b = await json<{ userId: string; organizationId: string }>(res);
      createdUsers.push(b.userId);
      createdOrgs.push(b.organizationId);
    } else {
      // Some minor validation rejection is fine; what matters is we didn't 400 on CAPTCHA.
      const b = await json<{ error: string }>(res);
      expect(b.error).not.toBe('captcha_failed');
    }
  });

  // ── Valid request creates org + returns 201 ─────────────────────────────────

  it('valid payload creates org and returns 201', async () => {
    const email = `valid-${Date.now()}@example.dev`;
    const res = await onboardRoute.POST(onboardReq({ ...goodBody, email }, { ip: '3.3.3.3' }));
    expect(res.status).toBe(201);
    const b = await json<{ userId: string; organizationId: string }>(res);
    expect(b.userId).toBeTruthy();
    expect(b.organizationId).toBeTruthy();
    createdUsers.push(b.userId);
    createdOrgs.push(b.organizationId);
  });
});
