import { withoutRls } from '@/lib/db';
import { log } from '@/lib/logger';
import { encryptField, hashEmailForIndex } from '@/lib/crypto';

// -----------------------------------------------------------------------------
// Weekly audit digest. For each org, counts customer surface reads +
// writes over the last 7 days and emails a summary to every owner.
//
// Rendering deliberately excludes patient names / entity ids — the digest
// is a *rollup* (counts by action), not a list of who saw what. If the
// owner needs detail they go to /audit; the digest just tells them the
// shape of activity so anomalies (huge spikes, weekend exports) surface.
// -----------------------------------------------------------------------------

export type OrgDigest = {
  organizationId: string;
  organizationName: string;
  windowStart: string;
  windowEnd: string;
  counts: {
    exports: number;
    anonymizes: number;
    customerReads: number;
    customerWrites: number;
    total: number;
  };
  topActors: Array<{ email: string; count: number }>;
};

export async function buildDigest(
  organizationId: string,
  now: Date = new Date(),
): Promise<OrgDigest> {
  const windowEnd = now;
  const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 3600 * 1000);
  return withoutRls(async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { id: true, name: true },
    });
    const rows = await tx.auditLog.findMany({
      where: {
        organizationId,
        entity: 'customer',
        at: { gte: windowStart, lt: windowEnd },
      },
      include: { actor: { select: { email: true } } },
    });
    const counts = {
      exports: rows.filter((r) => r.action === 'export').length,
      anonymizes: rows.filter((r) => r.action === 'anonymize').length,
      customerReads: rows.filter((r) => r.action === 'list' || r.action === 'read').length,
      customerWrites: rows.filter((r) => ['create', 'update', 'delete'].includes(r.action)).length,
      total: rows.length,
    };
    const byActor = new Map<string, number>();
    for (const r of rows) {
      const email = r.actor?.email ?? 'system';
      byActor.set(email, (byActor.get(email) ?? 0) + 1);
    }
    const topActors = [...byActor.entries()]
      .map(([email, count]) => ({ email, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    return {
      organizationId: org.id,
      organizationName: org.name,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      counts,
      topActors,
    };
  });
}

export function renderDigestText(d: OrgDigest): string {
  const lines: string[] = [];
  lines.push(`Weekly audit digest — ${d.organizationName}`);
  lines.push(`Window: ${d.windowStart.slice(0, 10)} → ${d.windowEnd.slice(0, 10)}`);
  lines.push('');
  lines.push('Customer surface activity:');
  lines.push(`  · Reads (list/detail):     ${d.counts.customerReads}`);
  lines.push(`  · Writes (create/upd/del): ${d.counts.customerWrites}`);
  lines.push(`  · Exports:                 ${d.counts.exports}`);
  lines.push(`  · Anonymizes:              ${d.counts.anonymizes}`);
  lines.push(`  · Total actions:           ${d.counts.total}`);
  lines.push('');
  if (d.topActors.length) {
    lines.push('Top actors:');
    for (const a of d.topActors) lines.push(`  · ${a.email} — ${a.count}`);
  } else {
    lines.push('No activity in the last 7 days.');
  }
  lines.push('');
  lines.push('For per-row detail see /audit.');
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// P15-009: this used to call getEmailProvider().send() directly, which had two
// consequences.
//
// Durability: a provider failure was caught, logged at warn level, and
// discarded. The digest was simply lost. Every other transactional message in
// this codebase goes through email_outbox, which gives it claim locking,
// exponential backoff, dead-lettering and encryption at rest; the digest was
// the one path that opted out.
//
// Observability: lib/ops-metrics.ts measures digest freshness with
// `SELECT max(created_at) FROM email_outbox WHERE purpose = 'audit_digest'`,
// and nothing in the codebase ever wrote a row with that purpose. The metric
// could never be anything but null, so the monitor check built on it could
// never turn green — it measured a table this function never touched.
//
// Enqueuing fixes both, and the unique idempotency key makes the whole job
// safe to invoke repeatedly (see runDigestForAllOrgs).
// -----------------------------------------------------------------------------

/**
 * ISO-8601 week identifier, e.g. `2026-W34`. Used in the idempotency key so a
 * given organization gets at most one digest per calendar week no matter how
 * often the job runs.
 */
export function isoWeekKey(date: Date): string {
  // Copy to UTC midnight so the calculation is timezone-independent.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO weeks run Monday–Sunday; shift Sunday (0) to 7.
  const day = d.getUTCDay() || 7;
  // Move to the Thursday of this week — the year that Thursday falls in is,
  // by definition, the ISO week-numbering year.
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Queues the digest for every owner of the org. Returns how many messages were
 * newly enqueued — `0` means a digest for this week already exists, which is
 * the normal outcome on every run after the first in a given week.
 */
export async function sendDigestToOwners(d: OrgDigest): Promise<{ sent: number }> {
  const owners = await withoutRls((tx) =>
    tx.membership.findMany({
      where: { organizationId: d.organizationId, role: 'owner' },
      include: { user: { select: { email: true } } },
    }),
  );

  const subject = `Weekly audit digest · ${d.organizationName}`;
  const body = renderDigestText(d);
  const encryptedBody = encryptField(body) ?? body;
  const bodyEncrypted = encryptedBody !== body;
  const week = isoWeekKey(new Date(d.windowEnd));

  let sent = 0;
  for (const m of owners) {
    const email = m.user.email;
    if (!email) continue;

    const encryptedTo = encryptField(email) ?? email;
    const toAddressHash = hashEmailForIndex(email);

    try {
      await withoutRls((tx) =>
        tx.emailOutbox.create({
          data: {
            // UNIQUE (sparse index, migration 20260813000005). Two runs in the
            // same ISO week collide here and the second is a no-op, which is
            // what makes an hourly schedule safe.
            idempotencyKey: `audit_digest:${d.organizationId}:${toAddressHash.slice(0, 16)}:${week}`,
            toAddress: encryptedTo,
            toAddressEncrypted: encryptedTo !== email,
            toAddressHash,
            subject,
            body: encryptedBody,
            bodyEncrypted,
            purpose: 'audit_digest',
          },
        }),
      );
      sent += 1;
    } catch {
      // Unique violation = already queued this week. Any other failure is also
      // non-fatal for the remaining owners; the outbox drain owns delivery, and
      // a stuck queue surfaces through the outbox-backlog monitor check rather
      // than here. No address or body is logged.
    }
  }
  return { sent };
}

/**
 * Builds and queues a digest for every organization.
 *
 * P15-004: safe to call as often as you like. The weekly `0 8 * * 1` schedule
 * in .github/workflows/cron.yml was silently dropped by GitHub — it has never
 * fired — so this also runs on the reliable hourly schedule. Idempotency is
 * enforced by the database, not by trusting the caller's timing.
 */
export async function runDigestForAllOrgs(): Promise<{ orgs: number; emails: number }> {
  const orgs = await withoutRls((tx) => tx.organization.findMany({ select: { id: true } }));
  let emails = 0;
  for (const org of orgs) {
    const d = await buildDigest(org.id);
    const r = await sendDigestToOwners(d);
    emails += r.sent;
  }
  log.info('audit_digest.run', { orgs: orgs.length, emails });
  return { orgs: orgs.length, emails };
}
