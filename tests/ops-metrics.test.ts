import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  collectOpsMetrics,
  assertMetricsAreNumericOnly,
  isUndefinedTableError,
} from '@/lib/ops-metrics';
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
      'ciphertext',
      'config',
      'cronHeartbeat',
      'housekeeping',
      'outbox',
      'partitions',
      'retention',
    ]);
    // Application-side proof of COMPLETION, as opposed to the GitHub Actions
    // run list's proof of INVOCATION. null until the job has run once.
    // The outcome fields were added because age alone cannot see a job that is
    // attempted every 15 minutes and fails every time.
    expect(Object.keys(metrics.cronHeartbeat).sort()).toEqual([
      'auditDigestMinutesAgo',
      'housekeepingMinutesAgo',
      'jobsNotSucceeding',
      'remindersAttemptMinutesAgo',
      'remindersExpectedUnits',
      'remindersFailedUnits',
      'remindersLastOutcome',
      'remindersLastUnits',
      'remindersMinutesAgo',
      'retentionMinutesAgo',
    ]);
    // P15-003: the digest metric carries two numbers now. The monitor needs
    // both to tell "nothing due yet" apart from "the weekly job never ran".
    // P15-010: counts of rows holding field-level ciphertext. Answers "is
    // there anything at risk from the key-format correction" without exposing
    // a single encrypted value.
    expect(Object.keys(metrics.ciphertext).sort()).toEqual([
      'customerFields',
      'mfaSecrets',
      'outboxRows',
      'total',
    ]);
    expect(metrics.ciphertext.total).toBe(
      metrics.ciphertext.customerFields +
        metrics.ciphertext.outboxRows +
        metrics.ciphertext.mfaSecrets,
    );

    // P15-010: the config block gained a validity count alongside the
    // presence counts. Presence alone said production was configured while
    // FIELD_ENCRYPTION_KEY was unparseable.
    // P17-007 added missingObservabilityEnv for the same class of problem:
    // the Sentry SDK installed and configured, and no DSN, so every uncaught
    // exception was discarded silently.
    // 2026-09-01 split the provider adapters out of invalidSecurityEnv: a
    // gateway on `mock` before launch is a decision, a malformed encryption key
    // is a P0, and one number could not mean both.
    // The four provider fields were added with PROVIDER_CONTRACT. Before them
    // PAYMENT_GATEWAY and SMS_PROVIDER were in no required-variable set at
    // all, so unsetting either left every count at zero while the resolver
    // threw on the first call.
    expect(Object.keys(metrics.config).sort()).toEqual([
      'deferredProviderEnv',
      'invalidSecurityEnv',
      'missingEmailEnv',
      'missingObservabilityEnv',
      'missingProviderCredentialEnv',
      'missingProviderEnv',
      'missingSecurityEnv',
      'missingSignupEnv',
      'mockedProviderEnv',
      'undeclaredMockProviderEnv',
      'unrecognisedProviderEnv',
    ]);

    expect(Object.keys(metrics.auditDigest).sort()).toEqual([
      'deliveryConfigMalformed',
      'deliveryEnabled',
      'distinctNormalizedRecipientAddresses',
      'eligibleOrganizations',
      'eligibleOrganizationsWithNoCustomers',
      'eligibleOwnerMemberships',
      'expectedDigestMessagesPerRun',
      'hoursSinceLastQueued',
      'knownFixtureDomain',
      'oldestEligibleOrgAgeHours',
      'otherAtOperatorDomain',
      'otherDistinctDomains',
      'otherUnclassified',
      'reservedTldNonFixture',
    ]);

    const dg = metrics.auditDigest;

    // The three categories are a PARTITION of the distinct addresses, not
    // overlapping tags. If this ever fails, a classification bucket has been
    // added or reordered without precedence and the totals stop meaning
    // anything.
    expect(dg.knownFixtureDomain + dg.reservedTldNonFixture + dg.otherUnclassified).toBe(
      dg.distinctNormalizedRecipientAddresses,
    );

    // The second pass narrows the 'other' bucket; it can never exceed it.
    expect(dg.otherAtOperatorDomain).toBeLessThanOrEqual(dg.otherUnclassified);
    expect(dg.otherDistinctDomains).toBeLessThanOrEqual(dg.otherUnclassified);
    expect(dg.eligibleOrganizationsWithNoCustomers).toBeLessThanOrEqual(dg.eligibleOrganizations);

    // Distinct inboxes can never exceed memberships: one person owning three
    // organizations is three memberships but one inbox.
    expect(dg.distinctNormalizedRecipientAddresses).toBeLessThanOrEqual(
      dg.eligibleOwnerMemberships,
    );

    // One intent per (organization, address) pair, so it is bounded above by
    // memberships and below by both the org count and the address count.
    expect(dg.expectedDigestMessagesPerRun).toBeLessThanOrEqual(dg.eligibleOwnerMemberships);
    expect(dg.expectedDigestMessagesPerRun).toBeGreaterThanOrEqual(dg.eligibleOrganizations);
    expect(dg.expectedDigestMessagesPerRun).toBeGreaterThanOrEqual(
      dg.distinctNormalizedRecipientAddresses > 0 ? 1 : 0,
    );
    // P15-004 put the digest on the hourly schedule, so the blast radius must
    // be knowable before it fires. A count, never an address.
    expect(dg.expectedDigestMessagesPerRun).toBeGreaterThanOrEqual(0);

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

  it('ciphertext count moves when an encrypted outbox row appears — P15-010', async () => {
    // A count that never changes is not a measurement. This is the number the
    // owner will read before editing FIELD_ENCRYPTION_KEY, so it has to be
    // demonstrably live rather than a constant zero.
    //
    // status 'sent', deliberately: a 'pending' row is drainable, and this one
    // claims to be encrypted while holding a placeholder, so the drain would
    // hand garbage to decryptField. It would also add to the backlog that
    // OD.3 in tests/outbox-durable.test.ts is sensitive to. The ciphertext
    // query does not filter on status, so 'sent' measures identically.
    const before = await collectOpsMetrics();

    await unsafePrismaAdmin.$executeRaw`
      INSERT INTO email_outbox (to_address, subject, body, purpose, status, to_address_encrypted, body_encrypted)
      VALUES ('ciphertext-placeholder', 'test', 'test', ${TEST_MARKER}, 'sent', true, true)
    `;

    const after = await collectOpsMetrics();
    expect(after.ciphertext.outboxRows).toBe(before.ciphertext.outboxRows + 1);
    expect(after.ciphertext.total).toBe(before.ciphertext.total + 1);

    await unsafePrismaAdmin.$executeRaw`DELETE FROM email_outbox WHERE purpose = ${TEST_MARKER}`;

    const restored = await collectOpsMetrics();
    expect(restored.ciphertext.outboxRows).toBe(before.ciphertext.outboxRows);
    expect(restored.ciphertext.total).toBe(before.ciphertext.total);
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

// -----------------------------------------------------------------------------
// Diagnostics boundary.
//
// The recipient classification and ciphertext inventory are operational
// intelligence about production. They belong on the CRON_SECRET-protected
// diagnostics endpoint and nowhere else. /api/health is unauthenticated and
// world-readable, so anything that leaks into it is public.
// -----------------------------------------------------------------------------
describe('public health endpoint stays minimal', () => {
  it('returns exactly {"ok":true} and nothing else', async () => {
    const route = await import('@/app/api/health/route');
    const res = await route.GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Object.keys(body)).toEqual(['ok']);
    expect(body.ok).toBe(true);
  });

  it('exposes no recipient, ciphertext or config intelligence', async () => {
    const route = await import('@/app/api/health/route');
    const text = await (await route.GET()).text();

    for (const leaked of [
      'recipient',
      'ciphertext',
      'eligible',
      'mfa',
      'outbox',
      'customer',
      'deliveryEnabled',
      'invalidSecurityEnv',
      '@',
    ]) {
      expect(text.toLowerCase()).not.toContain(leaked.toLowerCase());
    }
  });

  it('the diagnostics endpoint requires the bearer secret', async () => {
    // The complement: the data exists, but only behind auth.
    const route = await import('@/app/api/health/ops/route');
    const res = await route.GET(new Request('http://x/api/health/ops') as never);
    expect(res.status).toBe(401);
  });
});

// -----------------------------------------------------------------------------
// The heartbeat metric must not be able to take the whole endpoint down.
//
// Vercel builds the merge commit and migrate.yml applies the migration from the
// SAME push. They race, and Vercel usually wins — so for a minute or two the
// deployed code queries a table that does not exist yet. Without tolerance for
// that, /api/health/ops 500s, the monitor's ops probe fails, and every
// ops-derived check goes UNOBSERVABLE. That is the exact shape of incident #26,
// where the monitor read its own blindness as an all-clear.
//
// Tested through the predicate rather than by renaming the table. An
// `ALTER TABLE ... RENAME` takes an ACCESS EXCLUSIVE lock, and inside the full
// serial suite it contends with the shared Prisma pool: measured 2026-09-02,
// three such tests took the suite from 56s to 1901s and produced two unrelated
// timeout failures. The end-to-end behaviour was verified separately by
// renaming the table and observing all 25 ops-metrics tests still pass; what is
// locked in here is the decision that makes it work.
// -----------------------------------------------------------------------------
describe('a missing table degrades the heartbeat instead of 500ing the endpoint', () => {
  it('recognises 42P01 however Prisma happens to surface it', () => {
    // Three shapes, all seen from this client depending on version: a bare
    // Postgres code, a PrismaClientKnownRequestError wrapping it in meta, and
    // a message with nothing machine-readable at all.
    expect(isUndefinedTableError({ code: '42P01' })).toBe(true);
    expect(isUndefinedTableError({ code: 'P2010', meta: { code: '42P01' } })).toBe(true);
    expect(isUndefinedTableError({ message: 'relation "cron_heartbeat" does not exist' })).toBe(
      true,
    );
  });

  it('COMPLEMENT: does not swallow anything else', () => {
    // If this widened to "any error", a genuinely broken heartbeat query would
    // report null forever and look exactly like a fresh deployment — a failure
    // that reports health, which is the whole class this repo keeps hitting.
    expect(isUndefinedTableError({ code: '42703' })).toBe(false); // undefined_column
    expect(isUndefinedTableError({ code: '28P01' })).toBe(false); // bad password
    expect(isUndefinedTableError({ message: 'connection terminated' })).toBe(false);
    expect(isUndefinedTableError(new Error('timeout'))).toBe(false);
    expect(isUndefinedTableError(null)).toBe(false);
    expect(isUndefinedTableError(undefined)).toBe(false);
  });

  it('reads a real heartbeat back, so null is not the only value it can return', async () => {
    // Without this, the metric could be permanently null and both cases above
    // would still pass. No DDL, so no lock.
    await unsafePrismaAdmin.$executeRawUnsafe(
      `INSERT INTO cron_heartbeat (job, last_succeeded_at, last_units)
       VALUES ('reminders', NOW(), 7)
       ON CONFLICT (job) DO UPDATE SET last_succeeded_at = NOW(), last_units = 7`,
    );
    try {
      const metrics = await collectOpsMetrics();
      expect(metrics.cronHeartbeat.remindersMinutesAgo).not.toBeNull();
      expect(metrics.cronHeartbeat.remindersMinutesAgo!).toBeLessThan(1);
      expect(metrics.cronHeartbeat.remindersLastUnits).toBe(7);
      expect(() => assertMetricsAreNumericOnly(metrics)).not.toThrow();
    } finally {
      await unsafePrismaAdmin.$executeRawUnsafe(
        `DELETE FROM cron_heartbeat WHERE job = 'reminders'`,
      );
    }
  });

  it('reports null for a job that has never run', async () => {
    const metrics = await collectOpsMetrics();
    expect(metrics.cronHeartbeat.retentionMinutesAgo).toBeNull();
  });
});
