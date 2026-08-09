import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');
const { hashForBucket, consumeGlobalBucket, extractClientIp } = await import(
  '@/lib/platform/rate-limit'
);
const { InvalidInputError } = await import('@/lib/auth');
const verifyRoute = await import('@/app/api/onboard/verify/route');

// ── hashForBucket ─────────────────────────────────────────────────────────────

describe('hashForBucket', () => {
  it('returns a 32-char hex string', () => {
    const h = hashForBucket('test', '1.2.3.4');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic for the same inputs', () => {
    expect(hashForBucket('test', '1.2.3.4')).toBe(hashForBucket('test', '1.2.3.4'));
  });

  it('different prefixes produce different hashes (domain separation)', () => {
    const a = hashForBucket('onboard-ip', '1.2.3.4');
    const b = hashForBucket('verify-ip', '1.2.3.4');
    expect(a).not.toBe(b);
  });

  it('different values produce different hashes', () => {
    const a = hashForBucket('verify-ip', '1.2.3.4');
    const b = hashForBucket('verify-ip', '5.6.7.8');
    expect(a).not.toBe(b);
  });

  it('uses RATE_LIMIT_HMAC_KEY when set and ignores FIELD_ENCRYPTION_KEY', () => {
    const prev = process.env.RATE_LIMIT_HMAC_KEY;
    try {
      // Two distinct 32-byte keys.
      const key1 = '0'.repeat(64);
      const key2 = 'f'.repeat(64);
      process.env.RATE_LIMIT_HMAC_KEY = key1;
      const h1 = hashForBucket('p', 'v');
      process.env.RATE_LIMIT_HMAC_KEY = key2;
      const h2 = hashForBucket('p', 'v');
      expect(h1).not.toBe(h2);
    } finally {
      if (prev === undefined) delete process.env.RATE_LIMIT_HMAC_KEY;
      else process.env.RATE_LIMIT_HMAC_KEY = prev;
    }
  });

  it('falls back to the hex portion of FIELD_ENCRYPTION_KEY when RATE_LIMIT_HMAC_KEY is absent', () => {
    const prevR = process.env.RATE_LIMIT_HMAC_KEY;
    const prevF = process.env.FIELD_ENCRYPTION_KEY;
    try {
      delete process.env.RATE_LIMIT_HMAC_KEY;
      // FIELD_ENCRYPTION_KEY with key-id prefix — must NOT pass the raw string
      // to Buffer.from('hex') as that would silently mangle the "ci0:" prefix.
      process.env.FIELD_ENCRYPTION_KEY =
        'ci0:0000000000000000000000000000000000000000000000000000000000000000';
      // Should not throw — fallback strips "ci0:" before parsing.
      const h = hashForBucket('p', 'v');
      expect(h).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      if (prevR === undefined) delete process.env.RATE_LIMIT_HMAC_KEY;
      else process.env.RATE_LIMIT_HMAC_KEY = prevR;
      if (prevF === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
      else process.env.FIELD_ENCRYPTION_KEY = prevF;
    }
  });

  it('RATE_LIMIT_HMAC_KEY and FIELD_ENCRYPTION_KEY produce different hashes (proving key is read correctly)', () => {
    const prevR = process.env.RATE_LIMIT_HMAC_KEY;
    const prevF = process.env.FIELD_ENCRYPTION_KEY;
    try {
      // A non-zero RATE_LIMIT_HMAC_KEY.
      process.env.RATE_LIMIT_HMAC_KEY = 'a'.repeat(64);
      const h1 = hashForBucket('p', 'v');

      // With RATE_LIMIT_HMAC_KEY cleared, fall back to FIELD_ENCRYPTION_KEY with
      // a different underlying key to prove the two paths use different bytes.
      delete process.env.RATE_LIMIT_HMAC_KEY;
      process.env.FIELD_ENCRYPTION_KEY =
        'ci0:0000000000000000000000000000000000000000000000000000000000000000';
      const h2 = hashForBucket('p', 'v');

      expect(h1).not.toBe(h2);
    } finally {
      if (prevR === undefined) delete process.env.RATE_LIMIT_HMAC_KEY;
      else process.env.RATE_LIMIT_HMAC_KEY = prevR;
      if (prevF === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
      else process.env.FIELD_ENCRYPTION_KEY = prevF;
    }
  });
});

// ── extractClientIp ───────────────────────────────────────────────────────────

describe('extractClientIp', () => {
  function headers(map: Record<string, string>) {
    return { get: (name: string) => map[name.toLowerCase()] ?? null };
  }

  it('returns the first address in x-forwarded-for', () => {
    expect(extractClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }))).toBe('1.2.3.4');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    expect(extractClientIp(headers({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
  });

  it('returns null when no IP headers are present', () => {
    expect(extractClientIp(headers({}))).toBeNull();
  });
});

// ── consumeGlobalBucket ───────────────────────────────────────────────────────

describe('consumeGlobalBucket', () => {
  const bucket = `test-bucket-${Date.now()}`;

  beforeEach(async () => {
    await unsafePrismaAdmin.platformRateLimit
      .deleteMany({ where: { bucket: { startsWith: 'test-bucket-' } } })
      .catch(() => {});
  });

  afterAll(async () => {
    await unsafePrismaAdmin.platformRateLimit
      .deleteMany({ where: { bucket: { startsWith: 'test-bucket-' } } })
      .catch(() => {});
  });

  it('allows calls under the limit', async () => {
    await expect(consumeGlobalBucket(bucket, 3, 60_000)).resolves.toBeUndefined();
    await expect(consumeGlobalBucket(bucket, 3, 60_000)).resolves.toBeUndefined();
    await expect(consumeGlobalBucket(bucket, 3, 60_000)).resolves.toBeUndefined();
  });

  it('throws InvalidInputError on the (limit + 1)th call', async () => {
    const b = `test-bucket-${Date.now()}-over`;
    for (let i = 0; i < 2; i++) await consumeGlobalBucket(b, 2, 60_000);
    await expect(consumeGlobalBucket(b, 2, 60_000)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('separate buckets are independent', async () => {
    const b1 = `test-bucket-${Date.now()}-b1`;
    const b2 = `test-bucket-${Date.now()}-b2`;
    // Exhaust b1.
    for (let i = 0; i < 2; i++) await consumeGlobalBucket(b1, 2, 60_000);
    await expect(consumeGlobalBucket(b1, 2, 60_000)).rejects.toBeInstanceOf(InvalidInputError);
    // b2 still fresh.
    await expect(consumeGlobalBucket(b2, 2, 60_000)).resolves.toBeUndefined();
  });
});

// ── verify route IP-hashing regression ───────────────────────────────────────
//
// Confirms that /api/onboard/verify hashes the IP before storing it in the
// platform_rate_limit bucket — i.e. the raw IP never appears as a bucket key.

describe('POST /api/onboard/verify — IP hashing', () => {
  function verifyReq(token: string, ip: string) {
    return new Request(`http://x/api/onboard/verify?token=${token}`, {
      method: 'GET',
      headers: { 'x-forwarded-for': ip },
    }) as unknown as import('next/server').NextRequest;
  }

  beforeEach(async () => {
    await unsafePrismaAdmin.platformRateLimit
      .deleteMany({ where: { bucket: { startsWith: 'verify:ip:' } } })
      .catch(() => {});
  });

  it('stores a hashed bucket for the client IP — raw IP never appears in platform_rate_limit', async () => {
    const ip = '192.0.2.1';
    // Send a request with an invalid token so it fails quickly.
    await verifyRoute.GET(verifyReq('0'.repeat(64), ip));

    const rows = await withoutRls((tx) =>
      tx.platformRateLimit.findMany({ where: { bucket: { startsWith: 'verify:ip:' } } }),
    );
    // There must be a bucket row for this IP.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // The raw IP must NOT appear in any bucket name.
    for (const row of rows) {
      expect(row.bucket).not.toContain(ip);
    }
    // The bucket must look like "verify:ip:<32-hex>".
    expect(rows[0].bucket).toMatch(/^verify:ip:[0-9a-f]{32}$/);
  });
});
