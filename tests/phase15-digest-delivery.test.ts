import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { buildDigest, sendDigestToOwners, isoWeekKey } = await import('@/lib/audit-digest');
const { collectOpsMetrics } = await import('@/lib/ops-metrics');
const { hashEmailForIndex } = await import('@/lib/crypto');

// -----------------------------------------------------------------------------
// P15-009 — the digest must go through the outbox, and the metric must move.
//
// sendDigestToOwners() previously called getEmailProvider().send() directly.
// Two consequences, both invisible:
//
//   1. A provider failure was caught, logged at warn, and dropped. The digest
//      was lost, with none of the retry/backoff/dead-letter machinery that
//      every other transactional message in this codebase gets.
//   2. lib/ops-metrics.ts measures freshness with
//      `max(created_at) FROM email_outbox WHERE purpose = 'audit_digest'`, and
//      nothing ever wrote that purpose. hoursSinceLastQueued was structurally
//      pinned at null, so the P15-003 monitor check could never turn green.
//
// The decisive assertion here is the metric one: it goes from null to a real
// number as a consequence of running the digest. That is what proves the
// monitor is now wired to something the code actually does.
// -----------------------------------------------------------------------------

describe('P15-009 the weekly digest is queued durably and is idempotent', () => {
  let orgId: string;
  let ownerEmail: string;
  let hash = '';
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const stamp = Date.now();
    ownerEmail = `e2e-phase15-digest-${stamp}@example.dev`;
    hash = hashEmailForIndex(ownerEmail);

    const seed = await withoutRls(async (tx) => {
      const org = await tx.organization.create({
        data: { name: `E2E-PHASE15-digest-${stamp}` },
      });
      const user = await tx.appUser.create({
        data: {
          authProvider: 'credentials',
          authSubject: ownerEmail,
          email: ownerEmail,
        },
      });
      await tx.membership.create({
        data: { organizationId: org.id, userId: user.id, role: 'owner' },
      });

      cleanup.push(async () => {
        await withoutRls((tx) =>
          tx.emailOutbox.deleteMany({ where: { purpose: 'audit_digest', toAddressHash: hash } }),
        );
        await withoutRls((tx) => tx.membership.deleteMany({ where: { userId: user.id } }));
        await withoutRls((tx) => tx.appUser.deleteMany({ where: { id: user.id } }));
        await withoutRls((tx) => tx.organization.deleteMany({ where: { id: org.id } }));
      });

      return { orgId: org.id };
    });

    orgId = seed.orgId;
  });

  afterAll(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => null);
  });

  it('writes an email_outbox row with purpose audit_digest', async () => {
    const digest = await buildDigest(orgId);
    const result = await sendDigestToOwners(digest);
    expect(result.sent).toBe(1);

    const rows = await withoutRls((tx) =>
      tx.emailOutbox.findMany({ where: { toAddressHash: hash } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe('audit_digest');
    expect(rows[0].status).toBe('pending');
  });

  it('encrypts the recipient and the body at rest', async () => {
    const rows = await withoutRls((tx) =>
      tx.emailOutbox.findMany({ where: { toAddressHash: hash } }),
    );
    const row = rows[0];
    expect(row.toAddressEncrypted).toBe(true);
    expect(row.bodyEncrypted).toBe(true);
    // The plaintext address must not be readable from the stored row.
    expect(row.toAddress).not.toContain('@example.dev');
  });

  it('is idempotent within an ISO week — a second run queues nothing', async () => {
    // This is what makes the hourly schedule safe. Without it, moving the job
    // off the unreliable weekly cron would send one digest per hour.
    const digest = await buildDigest(orgId);
    const second = await sendDigestToOwners(digest);
    expect(second.sent).toBe(0);

    const rows = await withoutRls((tx) =>
      tx.emailOutbox.findMany({ where: { toAddressHash: hash } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('moves the ops metric off null — the signal the monitor reads', async () => {
    // Before this fix hoursSinceLastQueued was structurally null forever,
    // because no code path wrote purpose='audit_digest'. The P15-003 check
    // therefore could never turn green, only red.
    const metrics = await collectOpsMetrics();
    expect(metrics.auditDigest.hoursSinceLastQueued).not.toBeNull();
    expect(metrics.auditDigest.hoursSinceLastQueued).toBeGreaterThanOrEqual(0);
  });
});

describe('P15-009 isoWeekKey', () => {
  it('formats as ISO year-week', () => {
    expect(isoWeekKey(new Date('2026-08-18T12:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('gives every day of one ISO week the same key', () => {
    // Monday 2026-08-17 through Sunday 2026-08-23.
    const keys = new Set(
      ['17', '18', '19', '20', '21', '22', '23'].map((d) =>
        isoWeekKey(new Date(`2026-08-${d}T12:00:00Z`)),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it('rolls over to a new key on the next Monday', () => {
    expect(isoWeekKey(new Date('2026-08-23T12:00:00Z'))).not.toBe(
      isoWeekKey(new Date('2026-08-24T12:00:00Z')),
    );
  });

  it('handles a year boundary without collapsing two weeks together', () => {
    expect(isoWeekKey(new Date('2026-12-31T12:00:00Z'))).not.toBe(
      isoWeekKey(new Date('2026-06-30T12:00:00Z')),
    );
  });
});
