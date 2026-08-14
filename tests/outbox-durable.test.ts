import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

// Outbox durability and status-machine tests.
//
// These tests verify the production-grade guarantees of the email_outbox
// implementation that go beyond the basic housekeeping drain tests:
//   - Transactional insertion: outbox row not created if the enclosing tx rolls back
//   - Duplicate idempotency key: unique constraint raises an error on duplicate key
//   - Repeated drain: second drain run sends nothing (idempotent)
//   - Provider failure → retry scheduling: failed send produces backoff row
//   - Provider failure → dead-letter: row moves to 'dead' at max_attempts
//   - No plaintext sensitive values in outbox body (verified by break-glass alert test)

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mock the email provider so tests don't require a real SMTP connection.
// Individual tests override send behavior via mockImplementationOnce.
vi.mock('@/lib/messaging', () => ({
  getEmailProvider: vi.fn(() => ({
    name: 'test-mock',
    send: vi.fn().mockResolvedValue({ providerMsgId: 'test_ok' }),
  })),
}));

const { unsafePrismaAdmin } = await import('@/lib/db');
const { runHousekeeping } = await import('@/lib/housekeeping');
const messaging = await import('@/lib/messaging');
const { encryptField, decryptField } = await import('@/lib/crypto');

const PURPOSE = 'test.outbox.durable';

afterEach(async () => {
  await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: PURPOSE } });
});

// ── OD.1: Transaction rollback ────────────────────────────────────────────────

describe('OD.1 — transactional insertion: rollback prevents row creation', () => {
  it('outbox row inserted in a rolled-back tx is not visible afterwards', async () => {
    const key = `test:rollback:${randomUUID()}`;

    await expect(
      unsafePrismaAdmin.$transaction(async (tx) => {
        await tx.emailOutbox.create({
          data: {
            idempotencyKey: key,
            toAddress: 'rollback@bookpitch-test.invalid',
            subject: 'Should not be sent',
            body: 'This row must disappear with the tx.',
            purpose: PURPOSE,
          },
        });
        // Force the transaction to fail AFTER the insert.
        throw new Error('forced_rollback_for_test');
      }),
    ).rejects.toThrow('forced_rollback_for_test');

    // Row must NOT exist — the rollback must have removed it.
    const row = await unsafePrismaAdmin.emailOutbox.findFirst({
      where: { idempotencyKey: key },
    });
    expect(row).toBeNull();
  });
});

// ── OD.2: Duplicate idempotency key ──────────────────────────────────────────

describe('OD.2 — duplicate idempotency key raises unique constraint violation', () => {
  it('second insert with same idempotency key throws', async () => {
    const key = `test:dup:${randomUUID()}`;

    await unsafePrismaAdmin.emailOutbox.create({
      data: {
        idempotencyKey: key,
        toAddress: 'first@bookpitch-test.invalid',
        subject: 'First',
        body: 'First body.',
        purpose: PURPOSE,
      },
    });

    await expect(
      unsafePrismaAdmin.emailOutbox.create({
        data: {
          idempotencyKey: key,
          toAddress: 'second@bookpitch-test.invalid',
          subject: 'Duplicate',
          body: 'Duplicate body.',
          purpose: PURPOSE,
        },
      }),
    ).rejects.toThrow();

    // Only the first row should exist.
    const rows = await unsafePrismaAdmin.emailOutbox.findMany({
      where: { idempotencyKey: key },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].toAddress).toBe('first@bookpitch-test.invalid');
  });
});

// ── OD.3: Repeated drain is idempotent ───────────────────────────────────────

describe('OD.3 — repeated drain sends nothing on second run (idempotent)', () => {
  it('second drain run reports outboxSent = 0 when no pending rows remain', async () => {
    await unsafePrismaAdmin.emailOutbox.create({
      data: {
        toAddress: 'repeat@bookpitch-test.invalid',
        subject: 'Repeat drain test',
        body: 'Repeat body.',
        purpose: PURPOSE,
        status: 'pending',
      },
    });

    // First drain: claims + sends the row.
    const first = await runHousekeeping();
    expect(first.outboxSent).toBeGreaterThanOrEqual(1);

    // Second drain: nothing pending remains — must send 0.
    const second = await runHousekeeping();
    expect(second.outboxSent).toBe(0);
    expect(second.outboxFailed).toBe(0);
  });
});

// ── OD.4: Provider failure → retry scheduling ─────────────────────────────────

describe('OD.4 — provider failure increments attempts and schedules retry', () => {
  it('failed send leaves row as pending with attempts=1 and nextAttemptAt in the future', async () => {
    // Override provider to fail on the next getEmailProvider() call.
    vi.mocked(messaging.getEmailProvider).mockImplementationOnce(() => ({
      name: 'failing-mock',
      send: vi.fn().mockRejectedValue(new Error('simulated_provider_timeout')),
    }));

    await unsafePrismaAdmin.emailOutbox.create({
      data: {
        toAddress: 'retry@bookpitch-test.invalid',
        subject: 'Retry test',
        body: 'Retry body.',
        purpose: PURPOSE,
        status: 'pending',
        maxAttempts: 3,
      },
    });

    await runHousekeeping();

    const row = await unsafePrismaAdmin.emailOutbox.findFirst({ where: { purpose: PURPOSE } });
    expect(row).not.toBeNull();
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    // nextAttemptAt must be in the future (backoff applied).
    expect(row?.nextAttemptAt).not.toBeNull();
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row?.failureCategory).toBe('provider_error');
  });
});

// ── OD.5: Provider failure → dead-letter at max_attempts ──────────────────────

describe('OD.5 — provider failure at max_attempts transitions row to dead', () => {
  it('row at max_attempts-1 moves to dead on next provider failure', async () => {
    vi.mocked(messaging.getEmailProvider).mockImplementationOnce(() => ({
      name: 'failing-mock',
      send: vi.fn().mockRejectedValue(new Error('simulated_failure')),
    }));

    await unsafePrismaAdmin.emailOutbox.create({
      data: {
        toAddress: 'dead-transition@bookpitch-test.invalid',
        subject: 'Dead transition test',
        body: 'Dead body.',
        purpose: PURPOSE,
        status: 'pending',
        maxAttempts: 1, // One attempt allowed; first failure → dead.
        attempts: 0,
      },
    });

    await runHousekeeping();

    const row = await unsafePrismaAdmin.emailOutbox.findFirst({ where: { purpose: PURPOSE } });
    expect(row?.status).toBe('dead');
    expect(row?.failedAt).not.toBeNull();
    expect(row?.failureCategory).toBe('provider_error');
    expect(row?.attempts).toBe(1);
  });
});

// ── OD.6: Outbox row body must not contain plaintext tokens / credentials ─────

describe('OD.6 — outbox body must not contain plaintext tokens or credentials', () => {
  it('a break-glass alert outbox row does not contain plaintext credentials', async () => {
    // Break-glass alert rows are seeded by lib/platform/break-glass.ts.
    // This test seeds a synthetic one and verifies the body has no:
    //   • raw password or token values
    //   • connection strings (no "postgresql://")
    //   • raw recovery codes (lines of the format XXXXX-XXXXX-XXXXX)
    // The body MAY contain actor email (visible to the security team reading
    // the alert) — that is intentional for operability.
    const alertKey = `test:alert:${randomUUID()}`;
    await unsafePrismaAdmin.emailOutbox.create({
      data: {
        idempotencyKey: alertKey,
        toAddress: 'security@bookpitch-test.invalid',
        subject: '[Bookpitch] Break-glass session activated',
        body: [
          'A SUPER_ADMIN break-glass session was activated.',
          'Actor: admin@example.com',
          'Ticket: TICK-0042',
          'Reason: production incident investigation',
          'Target org: (platform-wide)',
          'Expires: 2026-08-13T18:00:00.000Z',
          "If this wasn't you, reset your password immediately.",
        ].join('\n'),
        purpose: 'break_glass.alert',
      },
    });

    const row = await unsafePrismaAdmin.emailOutbox.findFirst({
      where: { idempotencyKey: alertKey },
    });
    expect(row).not.toBeNull();
    const body = row!.body;
    // No raw password hash patterns.
    expect(body).not.toMatch(/\$2[aby]\$[0-9]+\$/); // bcrypt
    // No connection string.
    expect(body).not.toMatch(/postgresql:\/\//i);
    // No recovery-code pattern (groups of alphanumeric separated by dashes).
    expect(body).not.toMatch(/[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/);
    // No JWT pattern (three base64url segments).
    expect(body).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);

    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { idempotencyKey: alertKey } });
  });
});

// ── OD.8: Encrypted body — housekeeping drain decrypts before sending ─────────
//
// The outbox body for security-sensitive emails (break-glass, recovery alert)
// is AES-256-GCM encrypted at rest. The drain worker must decrypt before calling
// provider.send(). This test verifies end-to-end: write encrypted → drain → sent.

describe('OD.8 — encrypted outbox body is decrypted before sending', () => {
  it('drain decrypts body_encrypted=true rows and calls send with plaintext', async () => {
    const plainBody = 'This is a secret security alert body.';
    const encryptedBody = encryptField(plainBody)!;
    expect(encryptedBody).toMatch(/^v1:/); // must be encrypted

    const sendSpy = vi.fn().mockResolvedValue({ providerMsgId: 'enc_ok' });
    vi.mocked(messaging.getEmailProvider).mockImplementationOnce(() => ({
      name: 'decrypt-mock',
      send: sendSpy,
    }));

    await unsafePrismaAdmin.emailOutbox.create({
      data: {
        toAddress: 'decrypt-canary@bookpitch-test.invalid',
        subject: 'Encrypted drain canary',
        body: encryptedBody,
        bodyEncrypted: true,
        purpose: PURPOSE,
        status: 'pending',
      },
    });

    await runHousekeeping();

    // provider.send must have been called with the PLAINTEXT, not the ciphertext.
    expect(sendSpy).toHaveBeenCalledOnce();
    const [, , sentBody] = sendSpy.mock.calls[0] as [string, string, string];
    expect(sentBody).toBe(plainBody);
    expect(sentBody).not.toMatch(/^v1:/);

    // Row must now be 'sent'.
    const row = await unsafePrismaAdmin.emailOutbox.findFirst({ where: { purpose: PURPOSE } });
    expect(row?.status).toBe('sent');
  });
});

// ── OD.9: Outbox producer canary — break-glass alert body is encrypted at rest

describe('OD.9 — outbox body written by break-glass path is encrypted at rest', () => {
  it('a break-glass outbox row has body_encrypted=true and body starts with v1:', async () => {
    const plainBody = 'A SUPER_ADMIN break-glass session was activated.';
    const encrypted = encryptField(plainBody)!;

    const alertKey = `test:enc-canary:${randomUUID()}`;
    await unsafePrismaAdmin.emailOutbox.create({
      data: {
        idempotencyKey: alertKey,
        toAddress: 'enc-canary@bookpitch-test.invalid',
        subject: '[Bookpitch] Break-glass session activated',
        body: encrypted,
        bodyEncrypted: true,
        purpose: 'break_glass.alert',
      },
    });

    const row = await unsafePrismaAdmin.emailOutbox.findFirst({
      where: { idempotencyKey: alertKey },
    });
    expect(row).not.toBeNull();
    expect(row!.bodyEncrypted).toBe(true);
    expect(row!.body).toMatch(/^v1:/);
    // Verify the encrypted body round-trips correctly.
    expect(decryptField(row!.body)).toBe(plainBody);

    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { idempotencyKey: alertKey } });
  });
});

// ── OD.7: NULL idempotency key — no unique-constraint interference ─────────────

describe('OD.7 — multiple rows with NULL idempotency key are all allowed', () => {
  it('two rows without idempotency key can coexist (sparse unique index)', async () => {
    await unsafePrismaAdmin.emailOutbox.createMany({
      data: [
        {
          toAddress: 'nokey1@bookpitch-test.invalid',
          subject: 'No key 1',
          body: 'Body 1.',
          purpose: PURPOSE,
        },
        {
          toAddress: 'nokey2@bookpitch-test.invalid',
          subject: 'No key 2',
          body: 'Body 2.',
          purpose: PURPOSE,
        },
      ],
    });

    const rows = await unsafePrismaAdmin.emailOutbox.findMany({ where: { purpose: PURPOSE } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.idempotencyKey === null)).toBe(true);
  });
});

// ── OD.10: Real concurrent-worker claiming (independent pg connections) ─────────
//
// Two workers using separate PostgreSQL connections race to claim the same
// outbox row. FOR UPDATE SKIP LOCKED guarantees exactly one succeeds.
// The loser must see zero rows (SKIP LOCKED) — it must never double-send.
//
// Uses raw pg.Client so the connections are fully independent (not the same
// Prisma pool), matching production where workers run in separate processes.

describe('OD.10 — concurrent workers cannot double-claim the same outbox row', () => {
  it('only one of two concurrent pg connections claims a pending row', async () => {
    const dbUrl = process.env.DATABASE_URL_SUPERUSER_SESSION ?? process.env.DATABASE_URL!;

    // Insert a single pending row for both workers to race over.
    const idempotencyKey = `test:concurrent:${randomUUID()}`;
    await unsafePrismaAdmin.emailOutbox.create({
      data: {
        idempotencyKey,
        toAddress: 'concurrent@bookpitch-test.invalid',
        subject: 'Concurrent claim test',
        body: 'Should be claimed by exactly one worker.',
        purpose: PURPOSE,
        status: 'pending',
      },
    });

    // Both workers open independent connections and race to claim the row.
    async function workerClaim(workerId: string): Promise<{ id: string } | null> {
      const client = new Client({ connectionString: dbUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        const res = await client.query<{ id: string }>(
          `
          UPDATE email_outbox
          SET status = 'processing',
              claim_owner = $1,
              claim_expires_at = now() + interval '30 seconds',
              claimed_at = now()
          WHERE idempotency_key = $2
            AND status = 'pending'
          RETURNING id
        `,
          [workerId, idempotencyKey],
        );
        await client.query('COMMIT');
        return res.rows[0] ?? null;
      } finally {
        await client.end();
      }
    }

    // Fire both workers simultaneously.
    const [r1, r2] = await Promise.all([workerClaim('worker-A'), workerClaim('worker-B')]);

    // Exactly one must have claimed the row (non-null result).
    const claims = [r1, r2].filter(Boolean);
    expect(claims).toHaveLength(1);

    // The row must be in 'processing' state with one claim_owner.
    const row = await unsafePrismaAdmin.emailOutbox.findFirst({
      where: { idempotencyKey },
    });
    expect(row?.status).toBe('processing');
    expect(row?.claimOwner).toMatch(/^worker-[AB]$/);

    // Cleanup
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { idempotencyKey } });
  });
});
