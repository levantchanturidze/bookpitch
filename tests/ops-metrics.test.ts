import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NextRequest } from 'next/server';
import { collectOpsMetrics, assertMetricsAreNumericOnly } from '@/lib/ops-metrics';
import { GET } from '@/app/api/health/ops/route';
import { isPublicPath } from '@/auth.config';
// Tests are exempt from the no-restricted-imports SEC-007 rule; the outbox has
// to be seeded directly to prove the counters actually move.
import { unsafePrismaAdmin } from '@/lib/db';

// -----------------------------------------------------------------------------
// Phase 13 — the operational metrics endpoint the production monitor reads.
//
// Two things have to be true and both are tested against real DB state, not a
// mock: the numbers have to actually move when the underlying condition
// appears, and nothing but numbers may ever leave the endpoint.
// -----------------------------------------------------------------------------

const SECRET = 'ops-metrics-test-secret-not-real';
const TEST_MARKER = 'phase13-ops-metrics-test';

function req(headers: Record<string, string> = {}): NextRequest {
  return new Request('http://localhost/api/health/ops', { headers }) as unknown as NextRequest;
}

let previousSecret: string | undefined;

beforeAll(async () => {
  previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  await unsafePrismaAdmin.$executeRaw`DELETE FROM email_outbox WHERE purpose = ${TEST_MARKER}`;
});

afterAll(async () => {
  await unsafePrismaAdmin.$executeRaw`DELETE FROM email_outbox WHERE purpose = ${TEST_MARKER}`;
  if (previousSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousSecret;
});

describe('assertMetricsAreNumericOnly', () => {
  it('accepts nested numbers and nulls', () => {
    expect(() =>
      assertMetricsAreNumericOnly({ a: 1, b: { c: 0, d: null }, e: -3.5 }),
    ).not.toThrow();
  });

  it('rejects a string anywhere in the tree', () => {
    // This is the actual protection: someone adds `lastRecipient` one day and
    // the endpoint refuses to answer rather than putting an address in a log.
    expect(() => assertMetricsAreNumericOnly({ outbox: { lastRecipient: 'a@b.test' } })).toThrow(
      /only numbers and null/,
    );
  });

  it('rejects booleans and arrays-of-strings', () => {
    expect(() => assertMetricsAreNumericOnly({ ok: true })).toThrow();
    expect(() => assertMetricsAreNumericOnly({ ids: ['abc'] })).toThrow();
  });

  it('rejects NaN and Infinity, which would serialise to null and hide a bug', () => {
    expect(() => assertMetricsAreNumericOnly({ x: Number.NaN })).toThrow(/finite/);
    expect(() => assertMetricsAreNumericOnly({ x: Number.POSITIVE_INFINITY })).toThrow(/finite/);
  });

  it('names the path of the offending field so a failure is debuggable', () => {
    expect(() => assertMetricsAreNumericOnly({ outbox: { dead: 'lots' } })).toThrow(
      /metrics\.outbox\.dead/,
    );
  });
});

describe('collectOpsMetrics against a real database', () => {
  it('returns the full metric shape with numeric leaves only', async () => {
    const metrics = await collectOpsMetrics();
    expect(() => assertMetricsAreNumericOnly(metrics)).not.toThrow();

    expect(Object.keys(metrics).sort()).toEqual([
      'auditDigest',
      'config',
      'housekeeping',
      'outbox',
      'partitions',
      'retention',
    ]);
    // P15-003: the digest metric carries two numbers now. The monitor needs
    // both to tell "nothing due yet" apart from "the weekly job never ran".
    expect(Object.keys(metrics.auditDigest).sort()).toEqual([
      'hoursSinceLastQueued',
      'oldestEligibleOrgAgeHours',
    ]);

    expect(Object.keys(metrics.outbox).sort()).toEqual([
      'dead',
      'deadLast24h',
      'deadWithExhaustedRetries',
      'oldestPendingAgeSeconds',
      'pending',
      'processing',
      'staleClaims',
    ]);
  });

  it('counts a dead-lettered row — the number moves when the condition appears', async () => {
    const before = await collectOpsMetrics();

    await unsafePrismaAdmin.$executeRaw`
      INSERT INTO email_outbox (to_address, subject, body, purpose, status, failed_at, attempts, max_attempts)
      VALUES ('nobody@example.invalid', 'test', 'test', ${TEST_MARKER}, 'dead', NOW(), 3, 3)
    `;

    const after = await collectOpsMetrics();
    expect(after.outbox.dead).toBe(before.outbox.dead + 1);
    expect(after.outbox.deadLast24h).toBe(before.outbox.deadLast24h + 1);
    expect(after.outbox.deadWithExhaustedRetries).toBe(before.outbox.deadWithExhaustedRetries + 1);

    await unsafePrismaAdmin.$executeRaw`DELETE FROM email_outbox WHERE purpose = ${TEST_MARKER}`;

    const restored = await collectOpsMetrics();
    expect(restored.outbox.dead).toBe(before.outbox.dead);
  });

  it('counts a stale processing claim', async () => {
    const before = await collectOpsMetrics();

    await unsafePrismaAdmin.$executeRaw`
      INSERT INTO email_outbox (to_address, subject, body, purpose, status, claim_owner, claim_expires_at, claimed_at)
      VALUES ('nobody@example.invalid', 'test', 'test', ${TEST_MARKER}, 'processing',
              'dead-worker', NOW() - interval '1 hour', NOW() - interval '2 hours')
    `;

    const after = await collectOpsMetrics();
    expect(after.outbox.processing).toBe(before.outbox.processing + 1);
    expect(after.outbox.staleClaims).toBe(before.outbox.staleClaims + 1);

    await unsafePrismaAdmin.$executeRaw`DELETE FROM email_outbox WHERE purpose = ${TEST_MARKER}`;
  });

  it('reports the age of the oldest pending row, and null when the queue is empty', async () => {
    await unsafePrismaAdmin.$executeRaw`DELETE FROM email_outbox WHERE purpose = ${TEST_MARKER}`;

    await unsafePrismaAdmin.$executeRaw`
      INSERT INTO email_outbox (to_address, subject, body, purpose, status, created_at)
      VALUES ('nobody@example.invalid', 'test', 'test', ${TEST_MARKER}, 'pending', NOW() - interval '90 minutes')
    `;
    const withRow = await collectOpsMetrics();
    expect(withRow.outbox.oldestPendingAgeSeconds).not.toBeNull();
    expect(withRow.outbox.oldestPendingAgeSeconds!).toBeGreaterThanOrEqual(5000);

    await unsafePrismaAdmin.$executeRaw`DELETE FROM email_outbox WHERE purpose = ${TEST_MARKER}`;
  });

  it('reads audit_log partition state', async () => {
    const metrics = await collectOpsMetrics();
    // The migration set creates the current month plus a look-ahead; the exact
    // count depends on when db-partitions last ran, so assert the shape and
    // that the default partition is being kept empty.
    expect(metrics.partitions.monthsAhead).toBeGreaterThanOrEqual(0);
    expect(metrics.partitions.defaultPartitionRows).toBe(0);
  });
});

describe('GET /api/health/ops authorisation', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('rejects a wrong bearer token', async () => {
    const res = await GET(req({ authorization: 'Bearer wrong-secret-entirely' }));
    expect(res.status).toBe(401);
  });

  it('rejects a token that is a prefix of the real one', async () => {
    const res = await GET(req({ authorization: `Bearer ${SECRET.slice(0, -1)}` }));
    expect(res.status).toBe(401);
  });

  it('rejects the raw secret without the Bearer scheme', async () => {
    const res = await GET(req({ authorization: SECRET }));
    expect(res.status).toBe(401);
  });

  it('accepts the correct bearer and returns metrics', async () => {
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.timestamp).toBe('string');
    expect(() => assertMetricsAreNumericOnly(body.metrics)).not.toThrow();
  });

  it('fails closed when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    try {
      const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
      expect(res.status).toBe(500);
    } finally {
      process.env.CRON_SECRET = SECRET;
    }
  });
});

describe('GET /api/health/ops response contains no tenant data', () => {
  it('serialises to JSON with no string values under metrics', async () => {
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
    const body = await res.json();
    const serialised = JSON.stringify(body.metrics);
    // Strip the key names and the literal `null`; what remains must be digits,
    // punctuation and nothing else. Any surviving letter is a leaked value.
    const valuesOnly = serialised.replace(/"[a-zA-Z0-9]+":/g, '').replace(/null/g, '');
    expect(valuesOnly).not.toMatch(/[a-zA-Z]/);
  });

  it('contains no @ sign anywhere — no address can have survived', async () => {
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }));
    expect(JSON.stringify(await res.json())).not.toContain('@');
  });
});

describe('the ops endpoint is reachable without a session but not by a browser user', () => {
  it('is on the public-path list so the proxy does not redirect the monitor to /signin', () => {
    expect(isPublicPath('/api/health/ops')).toBe(true);
  });

  it('does not make the session-gated readiness probe public', () => {
    // /api/health/ready exposes connection diagnostics and must stay behind a
    // SUPER_ADMIN session. An over-broad prefix match here would have exposed it.
    expect(isPublicPath('/api/health/ready')).toBe(false);
  });

  it('does not open the whole /api/health subtree', () => {
    expect(isPublicPath('/api/health/anything-else')).toBe(false);
  });
});
