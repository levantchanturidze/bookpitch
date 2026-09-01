import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Provider behaviour is driven per-test. `sends` records what actually reached
// a provider, which is the only thing that means "the user got the email".
type Sent = { to: string; subject: string; body: string };
const sends: Sent[] = [];
let failNextSends = 0;

vi.mock('@/lib/messaging', () => ({
  getEmailProvider: () => ({
    name: 'test-mock',
    send: async (to: string, subject: string, body: string) => {
      if (failNextSends > 0) {
        failNextSends--;
        throw new Error('provider unavailable');
      }
      sends.push({ to, subject, body });
      return { providerMsgId: `test_${sends.length}` };
    },
  }),
  getSmsProvider: () => ({
    name: 'test-sms',
    send: async () => ({ providerMsgId: 'test_sms' }),
  }),
}));

const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');
const { requestPasswordReset, consumeReset } = await import('@/lib/auth/password-reset');
const { runHousekeeping } = await import('@/lib/housekeeping');
const { decryptField, hashEmailForIndex } = await import('@/lib/crypto');
const { collectOpsMetrics } = await import('@/lib/ops-metrics');
const logger = await import('@/lib/logger');

// -----------------------------------------------------------------------------
// P17-002 — password-reset mail is durable.
//
// It used to be `provider.send()` inside a try/catch that logged a warning and
// returned. The route then answered 202 "if the address exists, we sent a
// link". When the provider was down the email did not exist anywhere: no
// retry, no queue row, no alert. The user waited for mail that was never
// coming, and the one trace was a warn line.
//
// The assertions below are about outcomes, not structure: after a provider
// failure the message must still be somewhere that will retry, a later drain
// must actually deliver it, and exhausting the retries must show up in the
// metrics the production monitor reads.
// -----------------------------------------------------------------------------

const RESET_PURPOSE = 'password_reset.link';
const TEST_EMAIL = 'p17-durable@bp.test';

async function outboxRows(purpose = RESET_PURPOSE, to?: string) {
  return unsafePrismaAdmin.emailOutbox.findMany({
    where: { purpose, ...(to ? { toAddressHash: hashEmailForIndex(to) } : {}) },
    orderBy: { createdAt: 'asc' },
  });
}

/** Sends that went to this test's own recipient. The suite shares one database
 *  and runHousekeeping() drains whatever else is queued, so a global count of
 *  `sends` would be measuring other test files. */
function sendsTo(to: string): Sent[] {
  return sends.filter((s) => s.to === to);
}

async function ensureUser(email: string): Promise<string> {
  const existing = await withoutRls((tx) => tx.appUser.findUnique({ where: { email } }));
  if (existing) return existing.id;
  const created = await withoutRls((tx) =>
    tx.appUser.create({
      data: { email, name: 'P17 Durable', authProvider: 'credentials', authSubject: email },
    }),
  );
  return created.id;
}

beforeEach(async () => {
  sends.length = 0;
  failNextSends = 0;
  await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: RESET_PURPOSE } });
  await unsafePrismaAdmin.verificationToken.deleteMany({ where: { identifier: TEST_EMAIL } });
});

afterEach(async () => {
  await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: RESET_PURPOSE } });
  await unsafePrismaAdmin.verificationToken.deleteMany({ where: { identifier: TEST_EMAIL } });
});

afterAll(async () => {
  // ensureUser() creates a membership-less app_user. tests/rbac-backfill.test.ts
  // asserts "active non-platform users without a membership → 0" against live
  // DB state, so leaving this behind fails an unrelated invariant test in the
  // same run. Remove it, and any earlier stragglers from the same fixture.
  await unsafePrismaAdmin.appUser.deleteMany({
    where: { email: { in: [TEST_EMAIL, 'p17-dbg@bp.test'] } },
  });
});

describe('password-reset delivery survives a provider outage', () => {
  it('a provider failure leaves the message queued for retry, not lost', async () => {
    await ensureUser(TEST_EMAIL);
    failNextSends = 1;

    await requestPasswordReset({ email: TEST_EMAIL });

    // Nothing was delivered…
    expect(sends.length).toBe(0);
    // …but the message is durable and scheduled for another attempt. This is
    // the whole difference from the old behaviour, where nothing remained.
    const rows = await outboxRows();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].attempts).toBeGreaterThanOrEqual(1);
  });

  it('the housekeeping drain then delivers the SAME link, not a new token', async () => {
    await ensureUser(TEST_EMAIL);
    failNextSends = 1;
    await requestPasswordReset({ email: TEST_EMAIL });

    const queued = (await outboxRows())[0];
    const queuedBody = queued.bodyEncrypted
      ? (decryptField(queued.body) ?? queued.body)
      : queued.body;
    const issued = await unsafePrismaAdmin.verificationToken.findFirstOrThrow({
      where: { identifier: TEST_EMAIL },
    });
    const issuedTokenHash = issued.token;

    // Make the row eligible immediately rather than waiting out the backoff.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox SET next_attempt_at = NOW() - interval '1 minute'
      WHERE id = ${queued.id}::uuid`;

    await runHousekeeping();

    expect(sendsTo(TEST_EMAIL).length).toBe(1);
    // Same body means the same token — a retry must not mint a second
    // credential, or the first link would silently stop working.
    expect(sendsTo(TEST_EMAIL)[0].body).toBe(queuedBody);

    const after = await outboxRows();
    expect(after[0].status).toBe('sent');

    // Same token, specifically: the link that went out hashes to the row that
    // was issued at request time, so no second credential was minted.
    const delivered = /token=([^\s&]+)/.exec(sendsTo(TEST_EMAIL)[0].body)?.[1];
    expect(delivered).toBeTruthy();
    expect(createHash('sha256').update(decodeURIComponent(delivered!)).digest('hex')).toBe(
      issuedTokenHash,
    );
  });

  it('the delivered link actually resets the password', async () => {
    // End-to-end, on the immediate-delivery path. Deliberately does NOT run
    // housekeeping: on a Postgres session whose TimeZone is not UTC,
    // runHousekeeping() deletes live verification tokens (see the P17-008 note
    // in docs/phase-17-stabilization-ledger.md — reproduced, pre-existing, and
    // already fixed on the frozen Phase 16 branch by commit 00577db). Coupling
    // this assertion to that bug would make an unrelated clock defect look
    // like a password-reset defect.
    await ensureUser(TEST_EMAIL);
    await requestPasswordReset({ email: TEST_EMAIL });

    expect(sends.length).toBe(1);
    const token = /token=([^\s&]+)/.exec(sends[0].body)?.[1];
    expect(token).toBeTruthy();
    await expect(
      consumeReset({ token: decodeURIComponent(token!), newPassword: 'p17-durable-pass' }),
    ).resolves.toMatchObject({ userId: expect.any(String) });

    // Consumed: the token is single-use.
    await expect(
      consumeReset({ token: decodeURIComponent(token!), newPassword: 'p17-durable-again' }),
    ).rejects.toThrow(/invalid or expired/i);
  });

  it('exhausted retries become a dead letter the ops metrics count', async () => {
    await ensureUser(TEST_EMAIL);
    failNextSends = 99; // provider is down for the whole test

    await requestPasswordReset({ email: TEST_EMAIL });

    // maxAttempts is 2 for reset mail; drive the drain until it gives up.
    for (let i = 0; i < 4; i++) {
      await unsafePrismaAdmin.$executeRaw`
        UPDATE email_outbox SET next_attempt_at = NOW() - interval '1 minute'
        WHERE purpose = ${RESET_PURPOSE} AND status = 'pending'`;
      await runHousekeeping();
    }

    const rows = await outboxRows();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('dead');
    expect(rows[0].failureCategory).toBe('provider_error');

    // §16: a terminal failure has to be visible to an operator. This is the
    // number the production monitor alarms on.
    const metrics = await collectOpsMetrics();
    expect(metrics.outbox.dead).toBeGreaterThan(0);
    expect(metrics.outbox.deadLast24h).toBeGreaterThan(0);
  });

  it('COMPLEMENT: a healthy provider delivers immediately and queues nothing', async () => {
    await ensureUser(TEST_EMAIL);
    await requestPasswordReset({ email: TEST_EMAIL });

    expect(sends.length).toBe(1);
    const rows = await outboxRows();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('sent');
  });
});

describe('the security properties of password reset are unchanged', () => {
  it('an unknown address queues nothing — no enumeration signal', async () => {
    await requestPasswordReset({ email: `nobody-${randomUUID()}@bp.test` });
    expect(sends.length).toBe(0);
    expect((await outboxRows()).length).toBe(0);
  });

  it('the token is not stored in plaintext at rest', async () => {
    await ensureUser(TEST_EMAIL);
    await requestPasswordReset({ email: TEST_EMAIL });

    const row = (await outboxRows())[0];
    const token = /token=([^\s&]+)/.exec(sends[0].body)?.[1];
    expect(token).toBeTruthy();

    expect(row.bodyEncrypted).toBe(true);
    expect(row.body).not.toContain(token!);
    expect(row.toAddressEncrypted).toBe(true);
    expect(row.toAddress).not.toContain(TEST_EMAIL);
    // The hash is what makes the row findable without decrypting it.
    expect(row.toAddressHash).toBeTruthy();
    expect(row.toAddressHash).not.toContain(TEST_EMAIL);
  });

  it('the token never reaches the logs', async () => {
    await ensureUser(TEST_EMAIL);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      await requestPasswordReset({ email: TEST_EMAIL });
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
    const token = /token=([^\s&]+)/.exec(sends[0].body)?.[1];
    expect(token).toBeTruthy();
    expect(lines.join('\n')).not.toContain(token!);
    // Not vacuous — the request did log something.
    expect(lines.length).toBeGreaterThan(0);
  });

  it('a second request supersedes the first queued link instead of sending both', async () => {
    await ensureUser(TEST_EMAIL);
    // First request fails to deliver, so its row is still pending.
    failNextSends = 1;
    await requestPasswordReset({ email: TEST_EMAIL });
    expect((await outboxRows()).filter((r) => r.status === 'pending').length).toBe(1);

    // Second request invalidates the first token (verification_tokens is
    // cleared for the identifier), so the queued first email now carries a
    // dead link. It must not be delivered.
    await requestPasswordReset({ email: TEST_EMAIL });

    const rows = await outboxRows();
    expect(rows.length).toBe(2);
    const superseded = rows.filter((r) => r.failureCategory === 'superseded');
    expect(superseded.length).toBe(1);
    expect(superseded[0].status).toBe('dead');
    expect(rows.filter((r) => r.status === 'pending').length).toBe(0);

    // Draining now must not resurrect the superseded link.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox SET next_attempt_at = NOW() - interval '1 minute'
      WHERE purpose = ${RESET_PURPOSE}`;
    const before = sendsTo(TEST_EMAIL).length;
    await runHousekeeping();
    expect(sendsTo(TEST_EMAIL).length).toBe(before);
  });

  it('only one reset token is live at a time', async () => {
    await ensureUser(TEST_EMAIL);
    await requestPasswordReset({ email: TEST_EMAIL });
    await requestPasswordReset({ email: TEST_EMAIL });
    const tokens = await unsafePrismaAdmin.verificationToken.findMany({
      where: { identifier: TEST_EMAIL },
    });
    expect(tokens.length).toBe(1);
  });
});

describe('invitation delivery is durable too', () => {
  const INVITE_PURPOSE = 'invitation.link';

  afterEach(async () => {
    await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { purpose: INVITE_PURPOSE } });
  });

  it('a provider failure leaves the invitation queued, and the drain sends it', async () => {
    const { createInvitation } = await import('@/lib/invitations');
    const org = await withoutRls((tx) =>
      tx.organization.findFirstOrThrow({
        where: { name: { not: 'Isolation Corp' } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const owner = await withoutRls((tx) =>
      tx.membership.findFirstOrThrow({
        where: { organizationId: org.id, role: 'owner' },
        select: { id: true, userId: true },
      }),
    );
    const email = `p17-invite-${randomUUID().slice(0, 8)}@bp.test`;

    failNextSends = 1;
    const result = await createInvitation(
      { userId: owner.userId, email: 'owner@bp.test', organizationId: org.id },
      { email, role: 'receptionist' },
    );
    expect(result.url).toContain('/invite?token=');

    const queued = await outboxRows(INVITE_PURPOSE, email);
    expect(queued.length).toBe(1);
    expect(queued[0].status).toBe('pending');

    await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox SET next_attempt_at = NOW() - interval '1 minute'
      WHERE id = ${queued[0].id}::uuid`;
    await runHousekeeping();

    expect(sendsTo(email).length).toBe(1);
    expect((await outboxRows(INVITE_PURPOSE, email))[0].status).toBe('sent');

    await unsafePrismaAdmin.invitation.deleteMany({ where: { email } });
  });
});

// Keep the logger import meaningful for readers scanning the mocks above.
void logger;
