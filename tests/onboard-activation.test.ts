import { describe, it, expect, vi, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const { activatePendingRegistration, createPendingRegistration } = await import('@/lib/onboarding');
const { InvalidInputError } = await import('@/lib/auth');

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

describe('createPendingRegistration — expires_at uses DB clock', () => {
  const email = `clock-${Date.now()}@example.dev`;

  afterAll(async () => {
    await unsafePrismaAdmin.pendingRegistration.deleteMany({ where: { email } }).catch(() => {});
  });

  it('expires_at is ~24h from DB now(), not from Node.js now()', async () => {
    const ttlMs = 24 * 60 * 60 * 1000;
    await createPendingRegistration({
      email,
      password: 'StrongPass123',
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
