import type { MessageChannel, PrismaClient } from '@prisma/client';
import { InvalidInputError, type ActiveSession } from '@/lib/auth';
import { withOrg, withoutRls } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { notifyEvent } from '@/lib/notifications';
import { getEmailProvider, getSmsProvider } from './index';
import { RateLimit } from '@/lib/rate-limit';
import { toLocalDate, toLocalTimeHHMM } from '@/lib/tz';
import { log, sanitizeErrorMessage } from '@/lib/logger';
import {
  DEFAULT_EMAIL_SUBJECT,
  DEFAULT_EMAIL_TEMPLATE,
  DEFAULT_SMS_TEMPLATE,
  renderTemplate,
  type TemplateVars,
} from './templates';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

// -----------------------------------------------------------------------------
// One "send" attempt. Idempotency happens at (appointment_id, channel) — if a
// message_log row already exists in a non-failed state, we skip. Callers choose
// whether to bypass the lead-time window (send-now vs. cron tick).
// -----------------------------------------------------------------------------
// P17-004 — the provider call used to run inside the database transaction.
//
// The whole function body was wrapped in `withoutRls(...)`, which is
// `unsafePrismaAdmin.$transaction(...)`, and `provider.send()` was called from
// inside it. An SMS gateway that takes eight seconds to answer held a Postgres
// transaction open for eight seconds — and a gateway that hangs held one until
// the pool timed out. lib/db.ts caps each pool at PG_POOL_MAX (default 3, and
// unset in production), so three slow reminders exhaust the admin pool and the
// next request that needs it — a login lookup, a cron, the Stripe webhook —
// waits behind a third-party HTTP call. Idle-in-transaction also pins the
// oldest xmin, so autovacuum stops reclaiming across the whole database.
//
// `RateLimit.messaging()` was called from inside that transaction too. It goes
// through `withOrg`, which opens a SECOND transaction on the prismaApp pool, so
// every in-flight reminder held one connection from each pool for the duration
// of the network call.
//
// The work is now four phases, and only the short ones are transactional:
//
//   1. prepare  — read-only. Load the appointment, check for an existing
//                 reminder, render the body, resolve the destination address.
//   2. limit    — RateLimit.messaging(), outside any transaction.
//   3. claim    — short write transaction. Locks the appointment row, RE-checks
//                 for a duplicate under that lock, inserts the `queued` row.
//   4. deliver  — provider.send() with no transaction open.
//   5. settle   — short write transaction. Marks sent/failed, writes the audit
//                 row, raises the in-app notification.
//
// Phase 3 also fixes a race the old shape did not actually prevent. Dedup was
// check-then-insert with no unique constraint on (appointment_id, channel) and
// no row lock; at READ COMMITTED two concurrent callers — a cron tick and an
// operator pressing "Send now" — could both see "not reminded" and both insert.
// The `FOR UPDATE` on the appointment serialises claims per appointment, so the
// second caller sees the first's committed row and reports skipped_duplicate.
//
// Ordering note: the duplicate and missing-contact checks stay BEFORE the rate
// limiter, as they were, so a skipped send never spends a token.
// -----------------------------------------------------------------------------

export type SendOutcome =
  'sent' | 'skipped_duplicate' | 'skipped_missing_contact' | 'rate_limited' | 'failed';

/**
 * How long a `queued` message_log row is treated as a live claim.
 *
 * claim() commits the row as `queued` BEFORE the provider call, and
 * alreadyReminded() treated `queued` as proof of delivery. A crash between the
 * two therefore created a reminder that was never sent, never retried — the
 * stale row deduped every later attempt — and never reported missed, because
 * the missed-reminder metric also counted `queued` as delivered. Silent,
 * permanent, and invisible from all three directions at once.
 *
 * A row older than this is an abandoned claim: it no longer blocks a retry and
 * is settled as `failed` so it stops accumulating and becomes visible.
 * Comfortably longer than a tick's provider round-trips, so a live claim is
 * never stolen from a worker still running.
 */
export const REMINDER_CLAIM_TTL_MINUTES = 15;

/** Channels a reminder is attempted on. Both are required. */
export const CHANNELS: readonly MessageChannel[] = ['sms', 'email'] as const;

/** Per-tick channel accounting. Every field is a count; no PII, no raw errors. */
export type TickTally = {
  appointmentsExpected: number;
  appointmentsProcessed: number;
  channelsExpected: number;
  sent: number;
  duplicates: number;
  missingContact: number;
  rateLimited: number;
  providerFailed: number;
  unprocessed: number;
};
export type ChannelReport = { channel: MessageChannel; outcome: SendOutcome; error?: string };

async function alreadyReminded(
  tx: TxClient,
  appointmentId: string,
  channel: MessageChannel,
): Promise<boolean> {
  // Genuinely delivered. These dedupe forever.
  const delivered = await tx.messageLog.findFirst({
    where: { appointmentId, channel, state: { in: ['sent', 'delivered'] } },
    select: { id: true },
  });
  if (delivered) return true;

  // A live claim by another worker. Bounded by a lease: this used to include
  // every `queued` row regardless of age, so one crash between claim() and
  // settle blocked the reminder permanently.
  //
  // The cutoff is computed IN SQL, deliberately. `created_at` is defaulted by
  // PostgreSQL (`DEFAULT CURRENT_TIMESTAMP`, migration 20260721220810), so a
  // cutoff derived from `Date.now()` compares a database timestamp against a
  // Node one. The application runs on Vercel and the database on Supabase —
  // two machines, two NTP disciplines, nothing keeping them in step. Skew in
  // one direction steals a live claim and sends the customer a second
  // reminder; skew in the other keeps an abandoned claim alive so the reminder
  // is never retried. Same class as the retention cutoff (lib/retention-window
  // .ts) and the cron heartbeat, both already moved to the database clock.
  const live = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
      FROM message_log
     WHERE appointment_id = ${appointmentId}::uuid
       AND channel = ${channel}::message_channel
       AND state = 'queued'::message_state
       AND created_at >= NOW() - make_interval(mins => ${REMINDER_CLAIM_TTL_MINUTES}::int)
     LIMIT 1`;
  if (live.length > 0) return true;

  // Anything still `queued` here is an abandoned claim. Settle it as failed so
  // it stops deduping, stops accumulating, and shows up in the failure counts
  // instead of being invisible. Same clock, necessarily: this statement and
  // the one above must not be able to disagree about which rows are stale.
  await tx.$executeRaw`
    UPDATE message_log
       SET state = 'failed'::message_state
     WHERE appointment_id = ${appointmentId}::uuid
       AND channel = ${channel}::message_channel
       AND state = 'queued'::message_state
       AND created_at < NOW() - make_interval(mins => ${REMINDER_CLAIM_TTL_MINUTES}::int)`;
  return false;
}

function toDateTimeParts(startsAt: Date, timezone: string): { date: string; time: string } {
  return {
    date: toLocalDate(startsAt, timezone),
    time: toLocalTimeHHMM(startsAt, timezone),
  };
}

/** Everything phase 4 needs to talk to the provider, resolved before any lock. */
type Prepared = {
  organizationId: string;
  toAddress: string;
  body: string;
  subject: string;
  vars: TemplateVars;
};

/**
 * Phase 1 — read-only. Returns either a terminal report (nothing to send) or
 * the payload the later phases work from. Writes only in the
 * missing-contact case, and that write is its own short transaction.
 */
async function prepare(
  appointmentId: string,
  channel: MessageChannel,
): Promise<{ prepared: Prepared } | { report: ChannelReport }> {
  const loaded = await withoutRls(async (tx) => {
    const appt = await tx.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        customer: { select: { name: true, email: true, phone: true } },
        staff: { select: { name: true } },
        location: { select: { timezone: true } },
      },
    });
    if (!appt) return null;
    if (await alreadyReminded(tx, appointmentId, channel))
      return { appt, duplicate: true as const };
    const template = await tx.messageTemplate.findFirst({
      where: { organizationId: appt.organizationId, channel },
    });
    return { appt, duplicate: false as const, template };
  });

  if (!loaded) return { report: { channel, outcome: 'failed', error: 'appointment_not_found' } };
  if (loaded.duplicate) return { report: { channel, outcome: 'skipped_duplicate' } };

  const { appt, template } = loaded;
  const rawBody =
    template?.body ?? (channel === 'sms' ? DEFAULT_SMS_TEMPLATE : DEFAULT_EMAIL_TEMPLATE);

  const { date, time } = toDateTimeParts(appt.startsAt, appt.location.timezone);
  const vars: TemplateVars = {
    PatientName: appt.customer.name,
    StaffName: appt.staff.name,
    ServiceName: appt.serviceName,
    Date: date,
    Time: time,
  };
  const body = renderTemplate(rawBody, vars);
  const toAddress = channel === 'sms' ? appt.customer.phone : appt.customer.email;

  if (!toAddress) {
    // Record the skip so the operator sees WHY nothing went out. `failed` is
    // not in the dedup state set, so a later fix to the contact details lets
    // the reminder go out.
    await withoutRls((tx) =>
      tx.messageLog.create({
        data: {
          organizationId: appt.organizationId,
          appointmentId,
          channel,
          toAddress: '',
          body,
          state: 'failed',
        },
      }),
    );
    return { report: { channel, outcome: 'skipped_missing_contact' } };
  }

  return {
    prepared: {
      organizationId: appt.organizationId,
      toAddress,
      body,
      subject: renderTemplate(DEFAULT_EMAIL_SUBJECT, vars),
      vars,
    },
  };
}

/**
 * Phase 3 — short write transaction. Takes a row lock on the appointment so
 * two concurrent callers cannot both claim the same (appointment, channel),
 * re-checks for a duplicate under that lock, and inserts the anchor row.
 *
 * Returns null when another caller won the race.
 */
async function claim(
  appointmentId: string,
  channel: MessageChannel,
  prepared: Prepared,
): Promise<string | null> {
  return withoutRls(async (tx) => {
    // Serialises concurrent claims for this appointment. Held only for the
    // duration of this transaction, which contains no network call.
    await tx.$executeRaw`SELECT id FROM appointments WHERE id = ${appointmentId}::uuid FOR UPDATE`;
    if (await alreadyReminded(tx, appointmentId, channel)) return null;
    const queued = await tx.messageLog.create({
      data: {
        organizationId: prepared.organizationId,
        appointmentId,
        channel,
        toAddress: prepared.toAddress,
        body: prepared.body,
        state: 'queued',
      },
    });
    return queued.id;
  });
}

/**
 * Send one channel's reminder for one appointment. Called by both the cron tick
 * and the per-row "send now" UI. Uses `withoutRls` because the caller may be
 * system (cron) or user (session) — the org id comes from the row.
 *
 * Throws RateLimitedError when the org's per-minute messaging cap is spent;
 * that is unchanged, and no message_log row is left behind when it happens.
 */
export async function sendForAppointment(
  appointmentId: string,
  channel: MessageChannel,
): Promise<ChannelReport> {
  const step = await prepare(appointmentId, channel);
  if ('report' in step) return step.report;
  const prepared = step.prepared;

  // Per-minute per-org cap. Prevents a runaway cron / bug from firing a burst
  // of SMS billable to the org. Outside the transaction: it opens its own on
  // the prismaApp pool, and nesting the two is what made three slow sends
  // enough to starve both pools.
  try {
    await RateLimit.messaging(prepared.organizationId);
  } catch {
    // Reported as its own outcome rather than thrown. Throwing here aborted
    // the whole organization's tick, so one rate-limited appointment took the
    // rest of that organization's reminders with it.
    return { channel, outcome: 'rate_limited' };
  }

  const logId = await claim(appointmentId, channel, prepared);
  if (logId === null) return { channel, outcome: 'skipped_duplicate' };

  // ---- No transaction is open past this line. ----
  let providerName: string;
  let result: { providerMsgId: string };
  try {
    if (channel === 'sms') {
      const provider = getSmsProvider();
      providerName = provider.name;
      result = await provider.send(prepared.toAddress, prepared.body);
    } else {
      const provider = getEmailProvider();
      providerName = provider.name;
      result = await provider.send(prepared.toAddress, prepared.subject, prepared.body);
    }
  } catch (err) {
    // Settle the claim so the anchor row does not block a retry forever.
    // `failed` is outside the dedup state set, so the next tick tries again.
    await withoutRls((tx) =>
      tx.messageLog.update({ where: { id: logId }, data: { state: 'failed' } }),
    ).catch((settleErr) => {
      // The send already failed; losing the settle write too would leave the
      // row stuck in `queued`, which DOES block retries. Surface it.
      log.error('reminder.settle_failed', {
        appointmentId,
        channel,
        error: sanitizeErrorMessage(settleErr),
      });
    });
    return { channel, outcome: 'failed', error: (err as Error).message };
  }

  await withoutRls(async (tx) => {
    await tx.messageLog.update({
      where: { id: logId },
      data: { state: 'sent', providerMsgId: result.providerMsgId, sentAt: new Date() },
    });
    // System-actor audit row (no session here). Session-triggered "send now"
    // adds its own actor row in sendNowForSession.
    await tx.auditLog.create({
      data: {
        organizationId: prepared.organizationId,
        action: 'create',
        entity: 'appointment',
        entityId: appointmentId,
        meta: {
          reminder: { channel, provider: providerName, providerMsgId: result.providerMsgId },
        },
      },
    });
    await notifyEvent(tx, prepared.organizationId, {
      type: 'reminder',
      title: `Reminder sent (${channel})`,
      body: `${prepared.vars.PatientName} · ${prepared.vars.ServiceName}`,
    });
  });

  return { channel, outcome: 'sent' };
}

// -----------------------------------------------------------------------------
// Cron tick. Sends both channels for every appointment in the org's
// reminder_lead_hours window that hasn't already been reminded.
// -----------------------------------------------------------------------------

export type TickReport = {
  organizationId: string;
  windowFrom: string;
  windowTo: string;
  attempts: Array<{ appointmentId: string; reports: ChannelReport[] }>;
  /** Channel-level counts. See TickTally. */
  tally: TickTally;
  /** Set when the org's window was truncated by REMINDER_MAX_APPOINTMENTS_PER_TICK. */
  truncated?: boolean;
};

/**
 * Upper bound on appointments handled per org per tick. Each appointment costs
 * two provider round-trips, and the tick has to finish inside the serverless
 * invocation budget. A truncated tick is not lost work: the window is
 * recomputed from `now` on the next run and the remainder is still in it.
 */
const MAX_APPOINTMENTS_PER_TICK = Math.max(
  1,
  Number(process.env.REMINDER_MAX_APPOINTMENTS_PER_TICK ?? 200),
);

export { MIN_REMINDER_LEAD_HOURS } from './reminder-window';

export async function runReminderTick(organizationId: string): Promise<TickReport> {
  const org = await withoutRls((tx) =>
    tx.organization.findUnique({
      where: { id: organizationId },
      select: { reminderLeadHours: true },
    }),
  );
  if (!org) throw new InvalidInputError('organization not found');

  // Window: [NOW(), NOW() + leadHours], evaluated BY THE DATABASE.
  //
  // This used to be `const now = new Date()` with the bounds computed in Node
  // and compared against `starts_at`, which is a PostgreSQL timestamptz. The
  // application runs on Vercel and the database on Supabase — two machines,
  // two clocks — so the whole window slid with the application server's. A
  // fast clock opens it past appointments that are about to start, and once
  // they start they leave the window permanently: there is no later tick that
  // recovers them.
  //
  // Fourth instance of this class in this project, after retention, the cron
  // heartbeat and the claim lease. The shared contract is in
  // lib/messaging/reminder-eligibility.ts.
  // The LEFT JOIN is deliberate: the bounds come back even when nothing matches,
  // so the report describes the window that was actually queried rather than a
  // second one computed afterwards from a different clock.
  const rows = await withoutRls(
    (tx) =>
      tx.$queryRaw<Array<{ id: string | null; window_from: Date; window_to: Date }>>`
      WITH w AS (
        SELECT NOW() AS window_from,
               NOW() + make_interval(hours => o.reminder_lead_hours) AS window_to
          FROM organizations o
         WHERE o.id = ${organizationId}::uuid
      )
      SELECT a.id, w.window_from, w.window_to
        FROM w
        LEFT JOIN appointments a
          ON a.organization_id = ${organizationId}::uuid
         AND a.status NOT IN ('cancelled', 'completed')
         AND a.starts_at >= w.window_from
         AND a.starts_at <= w.window_to
       ORDER BY a.starts_at ASC
       LIMIT ${MAX_APPOINTMENTS_PER_TICK + 1}`,
  );
  const windowFrom = rows[0]?.window_from ?? new Date();
  const windowTo = rows[0]?.window_to ?? new Date();
  const appts = rows.filter((r): r is typeof r & { id: string } => r.id !== null);
  const truncated = appts.length > MAX_APPOINTMENTS_PER_TICK;
  const batch = truncated ? appts.slice(0, MAX_APPOINTMENTS_PER_TICK) : appts;

  const attempts: TickReport['attempts'] = [];
  for (const a of batch) {
    const reports: ChannelReport[] = [];
    for (const channel of CHANNELS) reports.push(await sendForAppointment(a.id, channel));
    attempts.push({ appointmentId: a.id, reports });
  }

  if (truncated) {
    log.warn('reminder.tick_truncated', {
      organizationId,
      limit: MAX_APPOINTMENTS_PER_TICK,
    });
  }

  // Channel-level accounting. The route used to count an organization as
  // "processed" whenever runReminderTick() resolved — and it resolves normally
  // when every provider send fails, because sendForAppointment() returns a
  // report rather than throwing. So a tick in which nothing reached anyone was
  // a fully successful organization.
  const flat = attempts.flatMap((a) => a.reports);
  const tally = {
    appointmentsExpected: appts.length,
    appointmentsProcessed: batch.length,
    channelsExpected: batch.length * CHANNELS.length,
    sent: flat.filter((r) => r.outcome === 'sent').length,
    duplicates: flat.filter((r) => r.outcome === 'skipped_duplicate').length,
    missingContact: flat.filter((r) => r.outcome === 'skipped_missing_contact').length,
    rateLimited: flat.filter((r) => r.outcome === 'rate_limited').length,
    providerFailed: flat.filter((r) => r.outcome === 'failed').length,
    // Appointments the limit stopped this tick from reaching at all.
    unprocessed: Math.max(0, appts.length - batch.length),
  };

  return {
    organizationId,
    windowFrom: windowFrom.toISOString(),
    windowTo: windowTo.toISOString(),
    attempts,
    tally,
    ...(truncated ? { truncated: true } : {}),
  };
}

// -----------------------------------------------------------------------------
// Session-aware "send now" for the UI. Uses withOrg so we know the caller
// has access to this appointment before we delegate to the RLS-bypass path.
// -----------------------------------------------------------------------------
export async function sendNowForSession(
  session: ActiveSession,
  appointmentId: string,
): Promise<ChannelReport[]> {
  // Confirm the appointment belongs to the caller's org before firing.
  const appt = await withOrg(session.organizationId, (tx) =>
    tx.appointment.findUnique({ where: { id: appointmentId }, select: { id: true } }),
  );
  if (!appt) throw new InvalidInputError('appointment not found');

  const reports = [
    await sendForAppointment(appointmentId, 'sms'),
    await sendForAppointment(appointmentId, 'email'),
  ];

  // A user-triggered send deserves a proper audit row with the actor.
  await withOrg(session.organizationId, async (tx) => {
    await writeAudit(tx, session, 'create', 'appointment', appointmentId, {
      reminder: { source: 'send-now', reports },
    });
  });

  return reports;
}
