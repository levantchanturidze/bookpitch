import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// What actually reached a provider is the only thing that means "the user got
// the email", so the provider records every send and can be told to fail.
type Sent = { to: string; subject: string; body: string };
const { sends, faults } = vi.hoisted(() => ({
  sends: [] as Array<{ to: string; subject: string; body: string }>,
  faults: {
    failNextSends: 0,
    failEnqueue: false,
    skipDrainWithdrawal: false,
    // Runs once, right after the provider takes an email to this address.
    afterSendTo: null as null | { to: string; run: () => Promise<void> },
  },
}));
vi.mock('@/lib/messaging', () => ({
  getEmailProvider: () => ({
    name: 'test-mock',
    send: async (to: string, subject: string, body: string) => {
      if (faults.failNextSends > 0) {
        faults.failNextSends--;
        throw new Error('provider unavailable');
      }
      sends.push({ to, subject, body });
      const hook = faults.afterSendTo;
      if (hook && hook.to === to) {
        faults.afterSendTo = null;
        await hook.run();
      }
      return { providerMsgId: `test_${sends.length}` };
    },
  }),
  getSmsProvider: () => ({ name: 'test-sms', send: async () => ({ providerMsgId: 'sms' }) }),
}));
// Fail the ENQUEUE inside the resend transaction, to prove the rotation, the
// withdrawal and the enqueue commit or roll back as one.
vi.mock('@/lib/messaging/outbox', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/messaging/outbox')>('@/lib/messaging/outbox');
  return {
    ...actual,
    enqueueEmail: (...args: Parameters<typeof actual.enqueueEmail>) =>
      faults.failEnqueue
        ? Promise.reject(new Error('injected: outbox insert failed'))
        : actual.enqueueEmail(...args),
    // The drain's pre-claim withdrawal, switchable off so the CLAIM's own
    // currency check can be proven on its own. With both in place a test cannot
    // tell defence in depth from a check that does nothing.
    cancelObsoleteVerificationEmails: (
      ...args: Parameters<typeof actual.cancelObsoleteVerificationEmails>
    ) =>
      faults.skipDrainWithdrawal
        ? Promise.resolve(0)
        : actual.cancelObsoleteVerificationEmails(...args),
  };
});

const { unsafePrismaAdmin, withoutRls } = await import('@/lib/db');
const { createPendingRegistration, resendPendingRegistration, activatePendingRegistration } =
  await import('@/lib/onboarding');
const { runHousekeeping } = await import('@/lib/housekeeping');
const { deliverNow } = await import('@/lib/messaging/outbox');
const { hashEmailForIndex } = await import('@/lib/crypto');
const { collectOpsMetrics } = await import('@/lib/ops-metrics');
const { InvalidInputError } = await import('@/lib/auth');
const resendRoute = await import('@/app/api/onboard/resend/route');

import type { NextRequest } from 'next/server';

// -----------------------------------------------------------------------------
// Backlog D — an obsolete verification email must not be sent as if its link
// still worked.
//
// A resend rotates the registration's token, which kills the link in every
// earlier email. Sign-up withdrew queued earlier emails; the resend path did
// not, so a sign-up email whose first send had failed — waiting in the outbox
// for a retry — was delivered by the next drain carrying a dead link, beside
// the new one. The same could happen to an email that outlived its token's
// expiry, or the account's activation, while it waited for a scheduled drain.
//
// Policy now:
//   1. Issuing a token withdraws every queued email carrying an earlier one,
//      in the SAME transaction that queues the replacement (sign-up and
//      resend alike) — so nothing about the old link changes until the new
//      link and its delivery intent both exist.
//   2. Every delivery path re-checks, immediately before sending, that the
//      email's link is still the registration's current, unexpired token.
//   3. Withdrawn mail is `cancelled` (reason `superseded`), never `dead`: it
//      did not fail, and `dead` is what the production monitor alarms on.
// -----------------------------------------------------------------------------

const PURPOSE = 'onboard.verify';
const ts = Date.now();
let n = 0;
const nextEmail = () => `vs-${ts}-${++n}@example.dev`;
const usedEmails: string[] = [];
const activated: Array<{ userId: string; organizationId: string }> = [];

function sendsTo(email: string): Sent[] {
  return sends.filter((s) => s.to === email);
}
function tokenIn(body: string): string {
  const t = /token=([0-9a-f]{64})/.exec(body)?.[1];
  if (!t) throw new Error('no verification link in the email body');
  return t;
}
const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
async function rows(email: string) {
  return unsafePrismaAdmin.emailOutbox.findMany({
    where: { purpose: PURPOSE, toAddressHash: hashEmailForIndex(email) },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      idempotencyKey: true,
      status: true,
      failureCategory: true,
      attempts: true,
    },
  });
}
async function currentTokenHash(email: string) {
  return (
    await unsafePrismaAdmin.pendingRegistration.findUnique({
      where: { email },
      select: { tokenHash: true },
    })
  )?.tokenHash;
}
async function signUp(email: string) {
  usedEmails.push(email);
  await createPendingRegistration({
    email,
    password: 'correct-horse-battery',
    fullName: 'Verify Supersession',
    orgName: `VS Org ${ts}`,
  });
}
/** Step outside the 5-minute resend cooldown without waiting for it. */
async function allowResendNow(email: string) {
  await unsafePrismaAdmin.$executeRaw`
    UPDATE pending_registrations SET expires_at = now() + interval '1 hour' WHERE email = ${email}`;
}
/** Make every queued verification email due, then run the real drain. */
async function drain() {
  await unsafePrismaAdmin.$executeRaw`
    UPDATE email_outbox SET next_attempt_at = now() - interval '1 minute'
     WHERE purpose = ${PURPOSE} AND status = 'pending'`;
  await runHousekeeping();
}

beforeEach(() => {
  sends.length = 0;
  faults.failNextSends = 0;
  faults.failEnqueue = false;
  faults.skipDrainWithdrawal = false;
  faults.afterSendTo = null;
});

afterAll(async () => {
  for (const a of activated) {
    const { resetAuditForOrgs } = await import('./helpers/audit-reset');
    await resetAuditForOrgs([a.organizationId]);
    await withoutRls(async (tx) => {
      await tx.membership.deleteMany({ where: { organizationId: a.organizationId } });
      await tx.location.deleteMany({ where: { organizationId: a.organizationId } });
      await tx.organization.update({
        where: { id: a.organizationId },
        data: { ownerUserId: null },
      });
    });
    await withoutRls(async (tx) => {
      await tx.appUser.deleteMany({ where: { id: a.userId } });
      await tx.organization.deleteMany({ where: { id: a.organizationId } });
    });
  }
  const hashes = usedEmails.map((e) => hashEmailForIndex(e));
  await unsafePrismaAdmin.emailOutbox.deleteMany({ where: { toAddressHash: { in: hashes } } });
  await unsafePrismaAdmin.pendingRegistration.deleteMany({ where: { email: { in: usedEmails } } });
});

// -----------------------------------------------------------------------------
describe('one current link per registration — in the inbox, not only in the database', () => {
  it('sign-up sends exactly one email, whose link is the current token', async () => {
    const email = nextEmail();
    await signUp(email);
    expect(sendsTo(email)).toHaveLength(1);
    expect(sha(tokenIn(sendsTo(email)[0].body))).toBe(await currentTokenHash(email));
    expect((await rows(email)).map((r) => r.status)).toEqual(['sent']);
  });

  it('THE REGRESSION: a resend withdraws the queued earlier email, and the drain sends only the new link', async () => {
    const email = nextEmail();
    faults.failNextSends = 1; // the sign-up email's first send fails → it waits for a retry
    await signUp(email);
    expect((await rows(email)).map((r) => r.status)).toEqual(['pending']);
    const deadBefore = (await collectOpsMetrics()).outbox.dead;

    await allowResendNow(email);
    await resendPendingRegistration(email);

    const [old, fresh] = await rows(email);
    expect(old).toMatchObject({ status: 'cancelled', failureCategory: 'superseded' });
    expect(fresh.status).toBe('sent');

    await drain();
    // Exactly one email reached the user, and it carries the working link.
    expect(sendsTo(email)).toHaveLength(1);
    expect(sha(tokenIn(sendsTo(email)[0].body))).toBe(await currentTokenHash(email));
    // Withdrawn is not failed: the monitor's dead-letter count is untouched.
    expect((await collectOpsMetrics()).outbox.dead).toBe(deadBefore);
  });

  it('after a resend the old link is refused and the new one activates the account', async () => {
    const email = nextEmail();
    await signUp(email);
    const oldToken = tokenIn(sendsTo(email)[0].body);
    await allowResendNow(email);
    await resendPendingRegistration(email);
    const newToken = tokenIn(sendsTo(email)[1].body);
    expect(newToken).not.toBe(oldToken);

    await expect(activatePendingRegistration(oldToken)).rejects.toBeInstanceOf(InvalidInputError);
    const result = await activatePendingRegistration(newToken);
    activated.push({ userId: result.userId, organizationId: result.organizationId });
    expect(result.userId).toBeTruthy();

    // A verification email that is somehow still queued after activation is
    // withdrawn by the drain, not sent: there is no current link any more.
    const before = sendsTo(email).length;
    await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox SET status = 'pending'
       WHERE purpose = ${PURPOSE} AND to_address_hash = ${hashEmailForIndex(email)}`;
    await drain();
    expect(sendsTo(email).length).toBe(before);
    expect((await rows(email)).every((r) => r.status === 'cancelled')).toBe(true);
  });

  it('an email that comes back from a failed IN-FLIGHT send is withdrawn, not retried', async () => {
    // A row mid-send (`processing`) is not touched by the resend — that send
    // is in flight. If it then fails it returns to `pending` for a retry, still
    // carrying the link the resend killed. The delivery-time check stops it.
    const email = nextEmail();
    faults.failNextSends = 1;
    await signUp(email);
    const [first] = await rows(email);
    await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox SET status = 'processing', claim_owner = 'in-flight-test'
       WHERE id = ${first.id}::uuid`;

    await allowResendNow(email);
    await resendPendingRegistration(email);
    expect((await rows(email))[0].status).toBe('processing'); // untouched by the resend

    // …and the in-flight send fails, returning the row for a retry.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox SET status = 'pending', attempts = attempts + 1, claim_owner = NULL
       WHERE id = ${first.id}::uuid`;
    await drain();

    expect((await rows(email))[0]).toMatchObject({
      status: 'cancelled',
      failureCategory: 'superseded',
    });
    expect(sendsTo(email)).toHaveLength(1);
    expect(sha(tokenIn(sendsTo(email)[0].body))).toBe(await currentTokenHash(email));
  });

  it('a resend that commits AFTER the drain claimed the old email still keeps it from being sent', async () => {
    // Codex review on #115. The drain claims its batch, then sends one row at a
    // time. A resend committing in between withdraws only `pending` rows, and
    // the claimed one is `processing`: it went out carrying the killed link.
    const first = nextEmail();
    const second = nextEmail();
    faults.failNextSends = 2; // both sign-up emails wait for the drain
    await signUp(first);
    await signUp(second);
    const [stale] = await rows(second);
    // Both due, the first one earlier, so the drain claims both and sends the
    // first one first.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox SET next_attempt_at = now() - interval '2 minutes'
       WHERE purpose = ${PURPOSE} AND to_address_hash = ${hashEmailForIndex(first)}`;
    await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox SET next_attempt_at = now() - interval '1 minute'
       WHERE purpose = ${PURPOSE} AND to_address_hash = ${hashEmailForIndex(second)}`;
    // While the provider takes the first email, the second registrant resends.
    faults.afterSendTo = {
      to: first,
      run: async () => {
        await allowResendNow(second);
        await resendPendingRegistration(second);
      },
    };

    await runHousekeeping();

    expect(faults.afterSendTo, 'the resend never ran').toBeNull();
    expect((await rows(second)).find((r) => r.id === stale.id)).toMatchObject({
      status: 'cancelled',
      failureCategory: 'superseded',
    });
    // One email reached the second registrant: the resend's, with the live link.
    expect(sendsTo(second)).toHaveLength(1);
    expect(sha(tokenIn(sendsTo(second)[0].body))).toBe(await currentTokenHash(second));
    // COMPLEMENT: the first registrant's email, still current, was delivered.
    expect(sendsTo(first)).toHaveLength(1);
  });

  it('the claim itself refuses a stale link, even if the withdrawal step never ran', async () => {
    // A resend can land between the drain's withdrawal step and its claim.
    // The claim re-checks currency in the same statement, so the stale row is
    // left alone rather than sent.
    const email = nextEmail();
    faults.failNextSends = 1;
    await signUp(email);
    await allowResendNow(email);
    faults.failNextSends = 1; // the resend's immediate send fails too → its row waits
    await resendPendingRegistration(email);
    const [first] = await rows(email);
    // Put the stale email back in the queue as if the resend had never seen it.
    await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox SET status = 'pending', failure_category = NULL, failed_at = NULL
       WHERE id = ${first.id}::uuid`;

    faults.skipDrainWithdrawal = true;
    await drain();

    // Only the current link went out; the stale row was not claimed at all.
    expect(sendsTo(email)).toHaveLength(1);
    expect(sha(tokenIn(sendsTo(email)[0].body))).toBe(await currentTokenHash(email));
    expect((await rows(email))[0].status).toBe('pending');
  });

  it('an immediate delivery of a stale link is refused and the row withdrawn', async () => {
    // Every real caller hands deliverNow() the key it just queued, so this is
    // the guard for the caller that one day does not.
    const email = nextEmail();
    faults.failNextSends = 1;
    await signUp(email);
    const [stale] = await rows(email);
    await allowResendNow(email);
    await resendPendingRegistration(email); // rotates the token; stale row withdrawn
    await unsafePrismaAdmin.$executeRaw`
      UPDATE email_outbox SET status = 'pending', failure_category = NULL, failed_at = NULL
       WHERE id = ${stale.id}::uuid`;
    const before = sendsTo(email).length;

    expect(await deliverNow(stale.idempotencyKey!, PURPOSE)).toBe(false);
    expect(sendsTo(email).length).toBe(before);
    expect((await rows(email))[0]).toMatchObject({
      status: 'cancelled',
      failureCategory: 'superseded',
    });
  });

  it('a retry still carrying the CURRENT link is delivered — withdrawal is not blanket', async () => {
    const email = nextEmail();
    faults.failNextSends = 1;
    await signUp(email);
    expect((await rows(email))[0]).toMatchObject({ status: 'pending', attempts: 1 });
    await drain();
    expect(sendsTo(email)).toHaveLength(1);
    expect((await rows(email))[0].status).toBe('sent');
  });

  it("an email that outlived its token's expiry is withdrawn, not sent", async () => {
    const email = nextEmail();
    faults.failNextSends = 1;
    await signUp(email);
    await unsafePrismaAdmin.$executeRaw`
      UPDATE pending_registrations SET expires_at = now() - interval '1 minute' WHERE email = ${email}`;
    await drain();
    expect(sendsTo(email)).toHaveLength(0);
    expect((await rows(email))[0]).toMatchObject({
      status: 'cancelled',
      failureCategory: 'superseded',
    });
  });
});

// -----------------------------------------------------------------------------
describe('resend under repetition, concurrency and failure', () => {
  it('a repeat resend inside the cooldown changes nothing', async () => {
    const email = nextEmail();
    await signUp(email);
    await allowResendNow(email);
    await resendPendingRegistration(email);
    const hashAfterFirst = await currentTokenHash(email);
    const countAfterFirst = (await rows(email)).length;

    await resendPendingRegistration(email); // inside the 5-minute cooldown
    expect(await currentTokenHash(email)).toBe(hashAfterFirst);
    expect((await rows(email)).length).toBe(countAfterFirst);
    expect(sendsTo(email)).toHaveLength(2); // sign-up + the one resend
  });

  it('two simultaneous resends rotate the token once and queue one email', async () => {
    const email = nextEmail();
    await signUp(email);
    await allowResendNow(email);
    await Promise.all([resendPendingRegistration(email), resendPendingRegistration(email)]);
    const keys = (await rows(email)).map((r) => r.idempotencyKey ?? '');
    expect(keys.filter((k) => k.startsWith('onboard_resend:'))).toHaveLength(1);
    expect(sendsTo(email)).toHaveLength(2);
    expect(sha(tokenIn(sendsTo(email)[1].body))).toBe(await currentTokenHash(email));
  });

  it('if the new email cannot be queued, the token is NOT rotated and the old email stands', async () => {
    const email = nextEmail();
    faults.failNextSends = 1;
    await signUp(email); // its email is queued, waiting for a retry
    const hashBefore = await currentTokenHash(email);
    await allowResendNow(email);

    faults.failEnqueue = true;
    await expect(resendPendingRegistration(email)).rejects.toThrow(/injected/);

    // All or nothing: the old link still works and its email is still queued.
    expect(await currentTokenHash(email)).toBe(hashBefore);
    expect((await rows(email)).map((r) => r.status)).toEqual(['pending']);
    faults.failEnqueue = false;
    await drain();
    expect(sendsTo(email)).toHaveLength(1);
    expect(sha(tokenIn(sendsTo(email)[0].body))).toBe(hashBefore);
  });
});

// -----------------------------------------------------------------------------
describe('the resend endpoint stays enumeration-safe', () => {
  async function postResend(email: string) {
    const res = await resendRoute.POST(
      new Request('http://localhost/api/onboard/resend', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      }) as unknown as NextRequest,
    );
    return { status: res.status, body: await res.json() };
  }

  it('answers identically for unknown, cooling-down and eligible addresses', async () => {
    const unknown = `vs-unknown-${ts}@example.dev`;
    const cooling = nextEmail();
    await signUp(cooling); // just issued: inside the cooldown
    const eligible = nextEmail();
    await signUp(eligible);
    await allowResendNow(eligible);

    const answers = [
      await postResend(unknown),
      await postResend(cooling),
      await postResend(eligible),
    ];
    for (const a of answers) expect(a).toEqual({ status: 202, body: { ok: true } });
    // …while only the eligible one actually got a new email.
    expect(sendsTo(unknown)).toHaveLength(0);
    expect(sendsTo(cooling)).toHaveLength(1);
    expect(sendsTo(eligible)).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
describe('withdrawn mail is kept no longer than failed mail', () => {
  it('cancelled rows older than 30 days are swept like dead ones; younger ones are kept', async () => {
    const email = nextEmail();
    usedEmails.push(email);
    const hash = hashEmailForIndex(email);
    const mk = (key: string, status: string, failedAgo: string | null, createdAgo: string) =>
      unsafePrismaAdmin.$executeRawUnsafe(
        `INSERT INTO email_outbox (idempotency_key, to_address, to_address_hash, subject, body,
                                   purpose, status, failed_at, created_at)
         VALUES ($1, 'x', $2, 's', 'b', '${PURPOSE}', $3,
                 ${failedAgo ? `now() - interval '${failedAgo}'` : 'NULL'},
                 now() - interval '${createdAgo}')`,
        `${key}-${ts}`,
        hash,
        status,
      );
    await mk('old-cancelled', 'cancelled', '31 days', '31 days');
    await mk('legacy-cancelled-no-failed-at', 'cancelled', null, '31 days');
    await mk('young-cancelled', 'cancelled', '1 day', '1 day');
    await mk('old-dead', 'dead', '31 days', '31 days');

    await runHousekeeping();

    const left = (
      await unsafePrismaAdmin.emailOutbox.findMany({
        where: { toAddressHash: hash },
        select: { idempotencyKey: true },
      })
    ).map((r) => r.idempotencyKey);
    expect(left).toEqual([`young-cancelled-${ts}`]);
  });
});
