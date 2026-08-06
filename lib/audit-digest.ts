import { withoutRls } from '@/lib/db';
import { getEmailProvider } from '@/lib/messaging';
import { log, sanitizeErrorMessage } from '@/lib/logger';

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

// Emails the digest to every owner of the org. Uses the current
// EMAIL_PROVIDER — mock in dev just logs the provider-msg-id.
export async function sendDigestToOwners(d: OrgDigest): Promise<{ sent: number }> {
  const owners = await withoutRls((tx) =>
    tx.membership.findMany({
      where: { organizationId: d.organizationId, role: 'owner' },
      include: { user: { select: { email: true } } },
    }),
  );
  const provider = getEmailProvider();
  const subject = `Weekly audit digest · ${d.organizationName}`;
  const body = renderDigestText(d);
  let sent = 0;
  for (const m of owners) {
    if (!m.user.email) continue;
    try {
      await provider.send(m.user.email, subject, body);
      sent += 1;
    } catch (err) {
      log.warn('audit_digest.email_failed', {
        organizationId: d.organizationId,
        error: sanitizeErrorMessage(err),
      });
    }
  }
  return { sent };
}

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
