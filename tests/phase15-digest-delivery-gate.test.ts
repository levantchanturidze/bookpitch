import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Spy on the provider factory so "did anything try to send?" is observable
// rather than inferred. The gate's whole promise is that nothing is sent.
const sendSpy = vi.fn();
vi.mock('@/lib/messaging', () => ({
  getEmailProvider: () => ({ name: 'spy', send: sendSpy }),
}));

const { withoutRls } = await import('@/lib/db');
const { hashEmailForIndex } = await import('@/lib/crypto');
const {
  buildDigest,
  sendDigestToOwners,
  runDigestForAllOrgs,
  auditDigestDeliveryMode,
  isAuditDigestDeliveryEnabled,
} = await import('@/lib/audit-digest');

// -----------------------------------------------------------------------------
// Pre-launch delivery gate for the audit digest.
//
// Production reports seven eligible owner mailboxes while the service has not
// been sold. Nothing may be queued or delivered until those are reconciled, so
// delivery is OFF unless AUDIT_DIGEST_ENABLED is exactly "true".
//
// "Disabled" has to mean zero outbox rows AND zero provider calls. Asserting
// only the return value would pass even if a row were written and then the
// count reported as zero.
// -----------------------------------------------------------------------------

const ORIG = process.env.AUDIT_DIGEST_ENABLED;

function setGate(value: string | undefined) {
  if (value === undefined) delete process.env.AUDIT_DIGEST_ENABLED;
  else Object.assign(process.env, { AUDIT_DIGEST_ENABLED: value });
}

afterAll(() => {
  if (ORIG === undefined) delete process.env.AUDIT_DIGEST_ENABLED;
  else Object.assign(process.env, { AUDIT_DIGEST_ENABLED: ORIG });
});

describe('the scheduled endpoint itself is inert while disabled', () => {
  const SECRET = 'gate-route-test-secret';
  const prevSecret = process.env.CRON_SECRET;

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.CRON_SECRET;
    else Object.assign(process.env, { CRON_SECRET: prevSecret });
  });

  it('POST /api/cron/audit-digest returns 200 skipped and sends nothing', async () => {
    // The requirement is about the SCHEDULED ENDPOINT, not just the library
    // function, so this exercises the actual route handler the cron calls.
    Object.assign(process.env, { CRON_SECRET: SECRET });
    setGate(undefined);
    sendSpy.mockClear();

    const route = await import('@/app/api/cron/audit-digest/route');
    const res = await route.POST(
      new Request('http://x/api/cron/audit-digest', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
      }) as never,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped: boolean; mode: string };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(body.mode).toBe('disabled');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('still rejects an unauthorised caller while disabled', async () => {
    // Pausing delivery must not soften the endpoint's auth. The gate returns
    // early, so it would be easy to accidentally return 200 before the bearer
    // check ever runs.
    Object.assign(process.env, { CRON_SECRET: SECRET });
    setGate(undefined);

    const route = await import('@/app/api/cron/audit-digest/route');
    const res = await route.POST(
      new Request('http://x/api/cron/audit-digest', { method: 'POST' }) as never,
    );

    expect(res.status).toBe(401);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('gate resolution fails closed', () => {
  it('is disabled when unset', () => {
    setGate(undefined);
    expect(auditDigestDeliveryMode()).toBe('disabled');
    expect(isAuditDigestDeliveryEnabled()).toBe(false);
  });

  it('is enabled ONLY by the exact literal "true"', () => {
    setGate('true');
    expect(auditDigestDeliveryMode()).toBe('enabled');
    expect(isAuditDigestDeliveryEnabled()).toBe(true);
  });

  it('tolerates surrounding whitespace on the enable literal', () => {
    setGate('  true  ');
    expect(auditDigestDeliveryMode()).toBe('enabled');
  });

  it('treats "false" and empty as a deliberate off, not a mistake', () => {
    for (const v of ['false', 'FALSE', '']) {
      setGate(v);
      expect(auditDigestDeliveryMode()).toBe('disabled');
    }
  });

  it('treats every near-miss as malformed and STILL disabled', () => {
    // The values a hurried operator actually types. None of them may start
    // sending mail to real people.
    for (const v of ['1', 'yes', 'TRUE', 'True', 'on', 'enabled', 'y', 'tru', '"true"']) {
      setGate(v);
      const mode = auditDigestDeliveryMode();
      expect(mode, `AUDIT_DIGEST_ENABLED=${v}`).toBe('disabled_malformed');
      expect(isAuditDigestDeliveryEnabled(), `AUDIT_DIGEST_ENABLED=${v}`).toBe(false);
    }
  });

  it('never enables on an injected environment that omits the variable', () => {
    expect(auditDigestDeliveryMode({})).toBe('disabled');
    expect(isAuditDigestDeliveryEnabled({})).toBe(false);
  });
});

describe('disabled means zero rows and zero provider calls', () => {
  let orgId: string;
  let ownerEmail: string;
  let hash = '';
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const stamp = Date.now();
    ownerEmail = `e2e-phase15-gate-${stamp}@example.dev`;
    hash = hashEmailForIndex(ownerEmail);

    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({ data: { name: `E2E-PHASE15-gate-${stamp}` } });
      const user = await tx.appUser.create({
        data: { authProvider: 'credentials', authSubject: ownerEmail, email: ownerEmail },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: user.id, role: 'owner' },
      });
      cleanup.push(async () => {
        await withoutRls((t) => t.emailOutbox.deleteMany({ where: { toAddressHash: hash } }));
        await withoutRls((t) => t.membership.deleteMany({ where: { userId: user.id } }));
        await withoutRls((t) => t.appUser.deleteMany({ where: { id: user.id } }));
        await withoutRls((t) => t.organization.deleteMany({ where: { id: org.id } }));
      });
      return { orgId: org.id };
    });
    orgId = seed.orgId;
  });

  afterAll(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => null);
  });

  beforeEach(() => sendSpy.mockClear());

  const outboxRows = () =>
    withoutRls((tx) => tx.emailOutbox.findMany({ where: { toAddressHash: hash } }));

  it('sendDigestToOwners writes nothing while disabled', async () => {
    setGate(undefined);
    const digest = await buildDigest(orgId);
    const result = await sendDigestToOwners(digest);

    expect(result.sent).toBe(0);
    expect(await outboxRows()).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('runDigestForAllOrgs writes nothing and reports the mode', async () => {
    setGate(undefined);
    const result = await runDigestForAllOrgs();

    expect(result.skipped).toBe(true);
    expect(result.mode).toBe('disabled');
    expect(result.emails).toBe(0);
    expect(result.orgs).toBe(0); // did not even enumerate organizations
    expect(await outboxRows()).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('a malformed value is just as inert as an absent one', async () => {
    setGate('yes');
    const result = await runDigestForAllOrgs();

    expect(result.skipped).toBe(true);
    expect(result.mode).toBe('disabled_malformed');
    expect(await outboxRows()).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('repeated scheduled executions while disabled stay side-effect-free', async () => {
    // The hourly cron will hit this endpoint every hour for as long as the gate
    // stays shut. Every one of those must be a no-op.
    setGate(undefined);
    for (let i = 0; i < 5; i++) {
      const r = await runDigestForAllOrgs();
      expect(r.skipped).toBe(true);
    }
    expect(await outboxRows()).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('enabled mode still queues durably and stays idempotent per week', async () => {
    // The gate must not have broken the behaviour it guards.
    setGate('true');
    const digest = await buildDigest(orgId);

    const first = await sendDigestToOwners(digest);
    expect(first.sent).toBe(1);

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe('audit_digest');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].toAddressEncrypted).toBe(true);
    expect(rows[0].bodyEncrypted).toBe(true);

    // Still the outbox, not a direct send.
    expect(sendSpy).not.toHaveBeenCalled();

    const second = await sendDigestToOwners(digest);
    expect(second.sent).toBe(0);
    expect(await outboxRows()).toHaveLength(1);

    // Leave the gate shut for anything that follows.
    setGate(undefined);
    await withoutRls((t) => t.emailOutbox.deleteMany({ where: { toAddressHash: hash } }));
  });
});
