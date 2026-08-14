import { describe, it, expect, vi, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const resendRoute = await import('@/app/api/onboard/resend/route');

import type { NextRequest } from 'next/server';
async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function resendReq(email: string, ip?: string): NextRequest {
  return new Request('http://x/api/onboard/resend', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
    body: JSON.stringify({ email }),
  }) as unknown as NextRequest;
}

function hashToken(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Seed a pending_registrations row using DB now() for expires_at.
 * offsetMs is relative to PostgreSQL now() — avoids Node/PG clock-skew issues.
 * Default: +24h (fresh token, cooldown NOT elapsed).
 */
async function seedPending(email: string, expiresOffsetMs = 24 * 3600 * 1000): Promise<string> {
  const rawToken = randomBytes(32);
  const tokenHash = hashToken(rawToken);
  await withoutRls(
    (tx) =>
      tx.$executeRaw`
      INSERT INTO pending_registrations
        (email, password_hash, full_name, org_name, location_name, location_type, token_hash, expires_at)
      VALUES
        (${email}, 'hashed', 'Test User', 'Test Org', 'Main', 'clinic', ${tokenHash},
         now() + (${expiresOffsetMs} * interval '1 millisecond'))
      ON CONFLICT (email) DO UPDATE SET
        token_hash = EXCLUDED.token_hash,
        expires_at = EXCLUDED.expires_at
    `,
  );
  return tokenHash;
}

async function cleanupPending(email: string): Promise<void> {
  await withoutRls(
    (tx) => tx.$executeRaw`DELETE FROM pending_registrations WHERE email = ${email}`,
  );
}

async function cleanupOutbox(email: string): Promise<void> {
  await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { toAddress: email } });
}

// Use the last two digits of Date.now() (mod 100) to vary the third octet per run.
// Prevents IP rate-limit exhaustion (3 req/hr) when the test suite runs repeatedly.
const TEST_IP_PREFIX = `198.51.${Date.now() % 100}`; // TEST-NET-3 subnet — reserved, never routes

// RESEND_TOKEN_TTL_MS   = 24h = 86_400_000 ms
// RESEND_COOLDOWN_MS    = 5min = 300_000 ms
// cooldown threshold    = TTL - cooldown = 86_100_000 ms (23h55m)
// resend allowed when:  expires_at < now() + 86_100_000 ms (cooldown elapsed)
// resend blocked when:  expires_at >= now() + 86_100_000 ms (fresh token)

describe('POST /api/onboard/resend', () => {
  const run = `${Date.now()}`;

  afterAll(async () => {
    const emails = [
      `resend-known-${run}@example.dev`,
      `resend-cooldown-${run}@example.dev`,
      `resend-rotated-${run}@example.dev`,
      `resend-concurrent-${run}@example.dev`,
      `resend-expired-${run}@example.dev`,
    ];
    for (const email of emails) {
      await cleanupPending(email).catch(() => {});
      await cleanupOutbox(email).catch(() => {});
    }
  });

  // ── Enumeration resistance ────────────────────────────────────────────────

  it('returns 202 for an unknown email (enumeration-safe)', async () => {
    const res = await resendRoute.POST(
      resendReq(`resend-unknown-${run}@example.dev`, `${TEST_IP_PREFIX}.10`),
    );
    expect(res.status).toBe(202);
    const body = await json<{ ok: boolean }>(res);
    expect(body.ok).toBe(true);
  });

  it('returns 202 for invalid email format', async () => {
    const res = await resendRoute.POST(resendReq('not-an-email', `${TEST_IP_PREFIX}.11`));
    expect(res.status).toBe(202);
  });

  // ── Already-activated account ─────────────────────────────────────────────

  it('returns 202 for an already-activated email — no outbox row created', async () => {
    const activeEmail = 'superadmin@bp.test';
    await cleanupOutbox(activeEmail);

    const res = await resendRoute.POST(resendReq(activeEmail, `${TEST_IP_PREFIX}.20`));
    expect(res.status).toBe(202);

    const rows = await unsafePrismaAdmin.emailOutbox.findMany({
      where: { toAddress: activeEmail, purpose: 'onboard.verify' },
    });
    expect(rows.length).toBe(0);
  });

  // ── Cooldown enforcement ──────────────────────────────────────────────────

  it('respects cooldown — no outbox row when token was issued within the last 5 minutes', async () => {
    const email = `resend-cooldown-${run}@example.dev`;
    // Default offset = +24h: expires_at = now() + 24h → 24h >= 23h55m → cooldown NOT elapsed.
    await seedPending(email);
    await cleanupOutbox(email);

    const res = await resendRoute.POST(resendReq(email, `${TEST_IP_PREFIX}.30`));
    expect(res.status).toBe(202); // still 202 — enumeration-safe

    const outboxRows = await unsafePrismaAdmin.emailOutbox.findMany({
      where: { toAddress: email, purpose: 'onboard.verify' },
    });
    expect(outboxRows.length).toBe(0); // no row: cooldown enforced at DB level

    // expires_at must NOT have changed (token rotation did not happen).
    const pending = await withoutRls(
      (tx) =>
        tx.$queryRaw<{ diff_s: number }[]>`
        SELECT EXTRACT(EPOCH FROM (expires_at - now()))::int AS diff_s
        FROM pending_registrations WHERE email = ${email}
      `,
    );
    // diff_s should still be ~86400 (24h), not ~86100 (23h55m — new rotation).
    expect(pending[0]!.diff_s).toBeGreaterThan(86100); // > 23h55m means cooldown not elapsed
  });

  // ── Successful resend ─────────────────────────────────────────────────────

  it('rotates the token and creates an outbox row when cooldown has elapsed', async () => {
    const email = `resend-known-${run}@example.dev`;
    // expires_at = now() + 23h → 23h < 23h55m → cooldown elapsed.
    const oldHash = await seedPending(email, 23 * 3600 * 1000);
    await cleanupOutbox(email);

    const res = await resendRoute.POST(resendReq(email, `${TEST_IP_PREFIX}.40`));
    expect(res.status).toBe(202);

    // A new outbox row must exist.
    const outboxRows = await unsafePrismaAdmin.emailOutbox.findMany({
      where: { toAddress: email, purpose: 'onboard.verify' },
    });
    expect(outboxRows.length).toBeGreaterThanOrEqual(1);
    expect(outboxRows[0].idempotencyKey).toMatch(/^onboard_resend:/);

    // Token hash must have changed.
    const pending = await withoutRls(
      (tx) =>
        tx.$queryRaw<{ token_hash: string }[]>`
        SELECT token_hash FROM pending_registrations WHERE email = ${email}
      `,
    );
    expect(pending[0]?.token_hash).not.toBe(oldHash);
  });

  it('new token hash differs from old one after successful rotation', async () => {
    const email = `resend-rotated-${run}@example.dev`;
    // expires_at = now() + 20h → cooldown elapsed.
    const oldHash = await seedPending(email, 20 * 3600 * 1000);
    await cleanupOutbox(email);

    await resendRoute.POST(resendReq(email, `${TEST_IP_PREFIX}.41`));

    const pending = await withoutRls(
      (tx) =>
        tx.$queryRaw<{ token_hash: string; diff_s: number }[]>`
        SELECT token_hash,
               EXTRACT(EPOCH FROM (expires_at - now()))::int AS diff_s
        FROM pending_registrations WHERE email = ${email}
      `,
    );
    expect(pending[0]?.token_hash).not.toBe(oldHash);
    // New expiry must be approximately now() + 24h.
    const diffS = pending[0]?.diff_s ?? 0;
    expect(diffS).toBeGreaterThan(23.5 * 3600);
    expect(diffS).toBeLessThan(24.5 * 3600);
  });

  // ── Outbox status machine ─────────────────────────────────────────────────

  it('outbox row starts as pending or sent (immediate drain may have run)', async () => {
    const email = `resend-concurrent-${run}@example.dev`;
    await seedPending(email, 22 * 3600 * 1000); // cooldown elapsed
    await cleanupOutbox(email);

    await resendRoute.POST(resendReq(email, `${TEST_IP_PREFIX}.50`));

    const rows = await unsafePrismaAdmin.emailOutbox.findMany({
      where: { toAddress: email, purpose: 'onboard.verify' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(['pending', 'sent']).toContain(rows[0].status);
  });

  // ── Expired pending registration ──────────────────────────────────────────

  it('allows resend for an expired pending registration — token is re-issued', async () => {
    const email = `resend-expired-${run}@example.dev`;
    // Seed with an already-expired token: expires_at = now() - 1min → cooldown definitely elapsed.
    const oldHash = await seedPending(email, -60_000);
    await cleanupOutbox(email);

    const res = await resendRoute.POST(resendReq(email, `${TEST_IP_PREFIX}.60`));
    expect(res.status).toBe(202);

    // A new outbox row should exist with a fresh 24h expiry.
    const outboxRows = await unsafePrismaAdmin.emailOutbox.findMany({
      where: { toAddress: email, purpose: 'onboard.verify' },
    });
    expect(outboxRows.length).toBeGreaterThanOrEqual(1);

    const pending = await withoutRls(
      (tx) =>
        tx.$queryRaw<{ token_hash: string; diff_s: number }[]>`
        SELECT token_hash,
               EXTRACT(EPOCH FROM (expires_at - now()))::int AS diff_s
        FROM pending_registrations WHERE email = ${email}
      `,
    );
    expect(pending[0]?.token_hash).not.toBe(oldHash);
    expect(pending[0]?.diff_s).toBeGreaterThan(23.5 * 3600); // fresh 24h token
  });
});
