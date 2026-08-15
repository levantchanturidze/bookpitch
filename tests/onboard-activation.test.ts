import { describe, it, expect, vi, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const { activatePendingRegistration, createPendingRegistration } = await import('@/lib/onboarding');
const { InvalidInputError } = await import('@/lib/auth');
const verifyRoute = await import('@/app/api/onboard/verify/route');

// ── Token format validation ───────────────────────────────────────────────────

describe('activatePendingRegistration — token format guard', () => {
  it.each([
    '',
    'short',
    'z'.repeat(64), // non-hex chars
    '0'.repeat(63), // 63 chars (not 64)
    '0'.repeat(65), // 65 chars (not 64)
  ])('rejects malformed token %j', async (token) => {
    await expect(activatePendingRegistration(token)).rejects.toBeInstanceOf(InvalidInputError);
  });
});

// ── Single-use token enforcement ──────────────────────────────────────────────
//
// This is the atomicity complement test: the token must be consumable exactly
// once. A second call with the same token — even a concurrent one — must fail.
//
// Before the atomicity fix, the DELETE and the entity creation were two
// separate withoutRls calls (separate transactions). A crash between them
// would consume the token without creating the account, and a concurrent
// request could slip through the gap. This test proves single-use holds.

describe('activatePendingRegistration — single-use token enforcement', () => {
  const email = `activation-once-${Date.now()}@example.dev`;
  let rawTokenHex: string;
  let createdUserId: string | null = null;
  let createdOrgId: string | null = null;

  afterAll(async () => {
    await withoutRls(async (tx) => {
      // Clean up entities created by activation (if any).
      if (createdUserId) {
        await tx.membership.deleteMany({ where: { userId: createdUserId } }).catch(() => {});
        await tx.appUser.delete({ where: { id: createdUserId } }).catch(() => {});
      }
      if (createdOrgId) {
        await tx.location.deleteMany({ where: { organizationId: createdOrgId } }).catch(() => {});
        await tx.organization.delete({ where: { id: createdOrgId } }).catch(() => {});
      }
      // Also clean up any leftover pending row.
      await tx.pendingRegistration.deleteMany({ where: { email } }).catch(() => {});
    });
  });

  it('plants a pending registration row directly', async () => {
    const rawToken = randomBytes(32);
    rawTokenHex = rawToken.toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await withoutRls(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO pending_registrations
          (email, password_hash, full_name, org_name, location_name, location_type, token_hash, expires_at)
        VALUES
          (${email}, 'fakehash', 'Test User', 'Test Org', 'Main', 'clinic', ${tokenHash}, ${expiresAt})
      `;
    });

    const row = await unsafePrismaAdmin.pendingRegistration.findUnique({ where: { email } });
    expect(row).toBeTruthy();
  });

  it('first activation succeeds and creates org + user', async () => {
    const result = await activatePendingRegistration(rawTokenHex);
    expect(result.userId).toBeTruthy();
    expect(result.organizationId).toBeTruthy();
    createdUserId = result.userId;
    createdOrgId = result.organizationId;

    // Pending row must be gone.
    const pending = await unsafePrismaAdmin.pendingRegistration.findUnique({ where: { email } });
    expect(pending).toBeNull();
  });

  it('second activation with the same token throws InvalidInputError (single-use)', async () => {
    // The token was consumed by the first activation. A second call must fail
    // with the same error as an invalid/expired token — no leaking of which
    // condition caused the rejection.
    await expect(activatePendingRegistration(rawTokenHex)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });
});

// ── Expired token rejection ───────────────────────────────────────────────────

describe('activatePendingRegistration — expired token rejection', () => {
  const email = `activation-expired-${Date.now()}@example.dev`;
  let rawTokenHex: string;

  afterAll(async () => {
    await unsafePrismaAdmin.pendingRegistration.deleteMany({ where: { email } }).catch(() => {});
  });

  it('plants an expired pending row', async () => {
    const rawToken = randomBytes(32);
    rawTokenHex = rawToken.toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    // Plant with expires_at in the past.
    const expiresAt = new Date(Date.now() - 1000);

    await withoutRls(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO pending_registrations
          (email, password_hash, full_name, org_name, location_name, location_type, token_hash, expires_at)
        VALUES
          (${email}, 'fakehash', 'Test User', 'Expired Org', 'Main', 'clinic', ${tokenHash}, ${expiresAt})
      `;
    });
  });

  it('rejects the expired token without consuming any row', async () => {
    await expect(activatePendingRegistration(rawTokenHex)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    // The row must still exist (DELETE WHERE expires_at > now() skipped it).
    const row = await unsafePrismaAdmin.pendingRegistration.findUnique({ where: { email } });
    expect(row).toBeTruthy();
  });
});

// ── Concurrent double-verify race ────────────────────────────────────────────
//
// Two goroutine-equivalent concurrent activations for the same token race to
// DELETE the pending row. PostgreSQL serialises the deletes — only one can
// DELETE WHERE token_hash=X AND expires_at > now() and return a row.
// The loser sees rows.length=0 and throws InvalidInputError.
// This proves the single-transaction atomicity fix prevents double-activation.

describe('activatePendingRegistration — concurrent double-verify (race)', () => {
  const email = `activation-race-${Date.now()}@example.dev`;
  let rawTokenHex: string;
  let createdUserId: string | null = null;
  let createdOrgId: string | null = null;

  afterAll(async () => {
    await withoutRls(async (tx) => {
      if (createdUserId) {
        await tx.membership.deleteMany({ where: { userId: createdUserId } }).catch(() => {});
        await tx.appUser.delete({ where: { id: createdUserId } }).catch(() => {});
      }
      if (createdOrgId) {
        await tx.location.deleteMany({ where: { organizationId: createdOrgId } }).catch(() => {});
        await tx.organization.delete({ where: { id: createdOrgId } }).catch(() => {});
      }
      await tx.pendingRegistration.deleteMany({ where: { email } }).catch(() => {});
    });
  });

  it('seeds a fresh pending row with DB now() + 24h', async () => {
    const rawToken = randomBytes(32);
    rawTokenHex = rawToken.toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    await withoutRls(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO pending_registrations
          (email, password_hash, full_name, org_name, location_name, location_type, token_hash, expires_at)
        VALUES
          (${email}, 'fakehash', 'Race User', 'Race Org', 'Main', 'clinic', ${tokenHash},
           now() + interval '24 hours')
      `;
    });
  });

  it('exactly one of two concurrent activations wins; the other gets InvalidInputError', async () => {
    // Fire two activations in parallel. Exactly one must succeed; the other must throw.
    const [r1, r2] = await Promise.allSettled([
      activatePendingRegistration(rawTokenHex),
      activatePendingRegistration(rawTokenHex),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');

    // Exactly one succeeds.
    expect(fulfilled).toHaveLength(1);
    // The loser throws InvalidInputError.
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(InvalidInputError);

    // Capture created IDs for cleanup.
    if (fulfilled[0].status === 'fulfilled') {
      createdUserId = fulfilled[0].value.userId;
      createdOrgId = fulfilled[0].value.organizationId;
    }

    // Pending row must be gone — the winner consumed it.
    const pending = await unsafePrismaAdmin.pendingRegistration.findUnique({ where: { email } });
    expect(pending).toBeNull();
  });
});

// ── pending_registrations expires_at is DB-computed ───────────────────────────
//
// createPendingRegistration now uses now() + interval rather than
// new Date(Date.now() + ttl). This test verifies the expires_at column is
// set relative to the DB clock, not the Node.js clock, by checking that
// the value is within a reasonable range of DB now().

// ── GET /api/onboard/verify — public-access and security headers ──────────────
//
// This is a public, unauthenticated route. Key security properties:
//  • No-cache prevents token URL from being stored in browser/proxy cache.
//  • Referrer-Policy: no-referrer prevents the token from leaking via HTTP Referer.
//  • On success: redirects to /onboard/success (token NOT in redirect URL).
//  • On invalid/expired token: redirects to /onboard/expired.
//  • On internal error: redirects to /onboard/error.
//  • Canonical redirect uses APP_URL base, not a raw relative path.

describe('GET /api/onboard/verify — public-access, redirect, and security headers', () => {
  function verifyReq(token: string, ip?: string): import('next/server').NextRequest {
    const url = `http://localhost/api/onboard/verify?token=${encodeURIComponent(token)}`;
    return new Request(url, {
      method: 'GET',
      headers: ip ? { 'x-forwarded-for': ip } : {},
    }) as unknown as import('next/server').NextRequest;
  }

  it('valid token → 302 redirect to /onboard/success (APP_URL-prefixed)', async () => {
    const run = Date.now();
    const email = `verify-ok-${run}@example.dev`;
    const { createPendingRegistration: cpr } = await import('@/lib/onboarding');
    const { withoutRls, unsafePrismaAdmin: uAdmin } = await import('@/lib/db');
    const { hashEmailForIndex } = await import('@/lib/crypto');

    // Create registration and capture the raw token from the outbox row.
    await cpr({ email, password: 'devpass123', fullName: 'V', orgName: 'VOrg' });
    const toHash = hashEmailForIndex(email);
    const outbox = await uAdmin.emailOutbox.findFirst({
      where: { toAddressHash: toHash, purpose: 'onboard.verify' },
    });
    expect(outbox).toBeTruthy();

    // The token is NOT stored — read the token_hash and do a fresh seeded token.
    const rawToken = (await import('node:crypto')).randomBytes(32);
    const rawTokenHex = rawToken.toString('hex');
    const tokenHash = (await import('node:crypto'))
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');
    await withoutRls(
      (tx) =>
        tx.$executeRaw`
        UPDATE pending_registrations SET token_hash = ${tokenHash} WHERE email = ${email}
      `,
    );

    const res = await verifyRoute.GET(verifyReq(rawTokenHex, '198.51.100.1'));

    expect([302, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toMatch(/\/onboard\/success$/);
    expect(location).not.toContain(rawTokenHex);

    // Cleanup
    const { decryptField } = await import('@/lib/crypto');
    const { withoutRls: wrl } = await import('@/lib/db');
    await wrl(async (tx) => {
      await tx.pendingRegistration.deleteMany({ where: { email } }).catch(() => {});
      // Delete created org+user
      const membership = await uAdmin.membership.findFirst({
        where: { user: { email } },
        select: { userId: true, organizationId: true },
      });
      if (membership) {
        await tx.membership.deleteMany({ where: { userId: membership.userId } }).catch(() => {});
        await tx.location
          .deleteMany({ where: { organizationId: membership.organizationId } })
          .catch(() => {});
        await tx.organization.delete({ where: { id: membership.organizationId } }).catch(() => {});
        await tx.appUser.delete({ where: { id: membership.userId } }).catch(() => {});
      }
    });
    await uAdmin.emailOutbox.deleteMany({ where: { toAddressHash: toHash } }).catch(() => {});
    void decryptField; // suppress unused warning
  });

  it('invalid token → redirect to /onboard/expired', async () => {
    const badToken = '0'.repeat(64);
    const res = await verifyRoute.GET(verifyReq(badToken, '198.51.100.2'));
    expect([302, 307]).toContain(res.status);
    expect(res.headers.get('location') ?? '').toMatch(/\/onboard\/expired$/);
  });

  it('malformed token (too short) → redirect to /onboard/expired', async () => {
    const res = await verifyRoute.GET(verifyReq('tooshort', '198.51.100.3'));
    expect([302, 307]).toContain(res.status);
    expect(res.headers.get('location') ?? '').toMatch(/\/onboard\/expired$/);
  });

  it('response has Cache-Control: no-store', async () => {
    const res = await verifyRoute.GET(verifyReq('0'.repeat(64), '198.51.100.4'));
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('response has Referrer-Policy: no-referrer', async () => {
    const res = await verifyRoute.GET(verifyReq('0'.repeat(64), '198.51.100.5'));
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('redirect URL uses APP_URL prefix from env, not a raw relative path', async () => {
    const saved = process.env.APP_URL;
    process.env.APP_URL = 'https://app.bookpitch.test';
    try {
      const res = await verifyRoute.GET(verifyReq('0'.repeat(64), '198.51.100.6'));
      const loc = res.headers.get('location') ?? '';
      expect(loc).toContain('https://app.bookpitch.test');
    } finally {
      if (saved !== undefined) process.env.APP_URL = saved;
      else delete process.env.APP_URL;
    }
  });

  it('token not present in any redirect URL', async () => {
    const sentinel = 'a'.repeat(64);
    const res = await verifyRoute.GET(verifyReq(sentinel, '198.51.100.7'));
    const loc = res.headers.get('location') ?? '';
    expect(loc).not.toContain(sentinel);
  });
});

// ── Onboarding status pages — robots metadata ─────────────────────────────────
//
// All four pages must export `metadata.robots = { index: false, follow: false }`.
// This prevents search engines from indexing transient state pages and
// leaking email addresses or token URLs from browser history/referrer.

describe('Onboarding status pages — robots: noindex, nofollow', () => {
  it.each([
    ['pending', 'app/(auth)/onboard/pending/page.tsx'],
    ['success', 'app/(auth)/onboard/success/page.tsx'],
    ['expired', 'app/(auth)/onboard/expired/page.tsx'],
    ['error', 'app/(auth)/onboard/error/page.tsx'],
  ])('%s page exports robots noindex metadata', async (_name, filePath) => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(filePath, 'utf8');
    expect(source).toContain('robots');
    expect(source).toContain('index: false');
    expect(source).toContain('follow: false');
  });

  it('success page exists and has robots noindex', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('app/(auth)/onboard/success/page.tsx', 'utf8');
    expect(source).toContain('index: false');
  });
});

describe('createPendingRegistration — expires_at uses DB clock', () => {
  const email = `clock-${Date.now()}@example.dev`;

  afterAll(async () => {
    await unsafePrismaAdmin.pendingRegistration.deleteMany({ where: { email } }).catch(() => {});
  });

  it('expires_at is ~24h from DB now(), not from Node.js now()', async () => {
    const ttlMs = 24 * 60 * 60 * 1000;
    await createPendingRegistration({
      email,
      password: 'devpass123',
      fullName: 'Clock Test',
      orgName: 'Clock Org',
      tokenTtlMs: ttlMs,
    });

    const [{ db_now }] = await unsafePrismaAdmin.$queryRaw<[{ db_now: Date }]>`
      SELECT now() AS db_now
    `;
    const row = await unsafePrismaAdmin.pendingRegistration.findUniqueOrThrow({ where: { email } });

    // expires_at should be approximately db_now + 24h.
    // Allow ±5 seconds for query time, not ±hours (which the Node.js clock skew would produce).
    const expectedExpiry = new Date(db_now.getTime() + ttlMs);
    const diffMs = Math.abs(row.expiresAt.getTime() - expectedExpiry.getTime());
    expect(diffMs).toBeLessThan(5_000);
  });
});
