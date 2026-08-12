import type { MessageChannel, PrismaClient } from '@prisma/client';
import { InvalidInputError, type ActiveSession } from '@/lib/auth';
import { withOrg, withoutRls } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { notifyEvent } from '@/lib/notifications';
import { getEmailProvider, getSmsProvider } from './index';
import { RateLimit } from '@/lib/rate-limit';
import { toLocalDate, toLocalTimeHHMM } from '@/lib/tz';
import {
  DEFAULT_EMAIL_SUBJECT,
  DEFAULT_EMAIL_TEMPLATE,
  DEFAULT_SMS_TEMPLATE,
  renderTemplate,
  type TemplateVars,
} from './templates';

type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

// -----------------------------------------------------------------------------
// One "send" attempt. Idempotency happens at (appointment_id, channel) — if
// a message_log row already exists in a non-failed state, we skip. Callers
// choose whether to bypass the lead-time window (send-now vs. cron tick).
// -----------------------------------------------------------------------------

export type SendOutcome = 'sent' | 'skipped_duplicate' | 'skipped_missing_contact' | 'failed';
export type ChannelReport = { channel: MessageChannel; outcome: SendOutcome; error?: string };

async function alreadyReminded(
  tx: TxClient,
  appointmentId: string,
  channel: MessageChannel,
): Promise<boolean> {
  const existing = await tx.messageLog.findFirst({
    where: { appointmentId, channel, state: { in: ['queued', 'sent', 'delivered'] } },
    select: { id: true },
  });
  return !!existing;
}

function toDateTimeParts(startsAt: Date, timezone: string): { date: string; time: string } {
  return {
    date: toLocalDate(startsAt, timezone),
    time: toLocalTimeHHMM(startsAt, timezone),
  };
}

/**
 * Send one channel's reminder for one appointment. Called by both the cron
 * tick and the per-row "send now" UI. Uses `withoutRls` because the caller
 * may be system (cron) or user (session) — the org id comes from the row.
 */
export async function sendForAppointment(
  appointmentId: string,
  channel: MessageChannel,
): Promise<ChannelReport> {
  return withoutRls(async (tx: TxClient): Promise<ChannelReport> => {
    const appt = await tx.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        customer: { select: { name: true, email: true, phone: true } },
        staff: { select: { name: true } },
        location: { select: { timezone: true } },
      },
    });
    if (!appt) return { channel, outcome: 'failed', error: 'appointment_not_found' };

    if (await alreadyReminded(tx, appointmentId, channel)) {
      return { channel, outcome: 'skipped_duplicate' };
    }

    const template = await tx.messageTemplate.findFirst({
      where: { organizationId: appt.organizationId, channel },
    });
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
      // Record the skip so the operator sees WHY nothing went out.
      await tx.messageLog.create({
        data: {
          organizationId: appt.organizationId,
          appointmentId,
          channel,
          toAddress: '',
          body,
          state: 'failed',
        },
      });
      return { channel, outcome: 'skipped_missing_contact' };
    }

    // Per-minute per-org cap. Prevents a runaway cron / bug from firing
    // a burst of SMS billable to the org. Errors surface as `failed` in
    // the outcome — the caller updates the appointment card accordingly.
    await RateLimit.messaging(appt.organizationId);

    // 1) Insert queued row first (idempotency anchor).
    const queued = await tx.messageLog.create({
      data: {
        organizationId: appt.organizationId,
        appointmentId,
        channel,
        toAddress,
        body,
        state: 'queued',
      },
    });

    try {
      let providerName: string;
      let result: { providerMsgId: string };
      if (channel === 'sms') {
        const provider = getSmsProvider();
        providerName = provider.name;
        result = await provider.send(toAddress, body);
      } else {
        const provider = getEmailProvider();
        providerName = provider.name;
        result = await provider.send(toAddress, renderTemplate(DEFAULT_EMAIL_SUBJECT, vars), body);
      }

      await tx.messageLog.update({
        where: { id: queued.id },
        data: {
          state: 'sent',
          providerMsgId: result.providerMsgId,
          sentAt: new Date(),
        },
      });
      // System-actor audit row (no session here). Session-triggered "send now"
      // adds its own actor row in sendNowForSession.
      await tx.auditLog.create({
        data: {
          organizationId: appt.organizationId,
          action: 'create',
          entity: 'appointment',
          entityId: appointmentId,
          meta: {
            reminder: { channel, provider: providerName, providerMsgId: result.providerMsgId },
          },
        },
      });
      await notifyEvent(tx, appt.organizationId, {
        type: 'reminder',
        title: `Reminder sent (${channel})`,
        body: `${appt.customer.name} · ${appt.serviceName}`,
      });
      return { channel, outcome: 'sent' };
    } catch (err) {
      await tx.messageLog.update({
        where: { id: queued.id },
        data: { state: 'failed' },
      });
      return { channel, outcome: 'failed', error: (err as Error).message };
    }
  });
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
};

export async function runReminderTick(organizationId: string): Promise<TickReport> {
  const now = new Date();

  const org = await withoutRls((tx) =>
    tx.organization.findUnique({
      where: { id: organizationId },
      select: { reminderLeadHours: true },
    }),
  );
  if (!org) throw new InvalidInputError('organization not found');

  // Window: [now, now + leadHours]. Anything landing there this tick catches.
  const windowFrom = now;
  const windowTo = new Date(now.getTime() + org.reminderLeadHours * 3600_000);

  const appts = await withoutRls((tx) =>
    tx.appointment.findMany({
      where: {
        organizationId,
        status: { notIn: ['cancelled', 'completed'] },
        startsAt: { gte: windowFrom, lte: windowTo },
      },
      select: { id: true },
    }),
  );

  const attempts: TickReport['attempts'] = [];
  for (const a of appts) {
    const reports: ChannelReport[] = [];
    reports.push(await sendForAppointment(a.id, 'sms'));
    reports.push(await sendForAppointment(a.id, 'email'));
    attempts.push({ appointmentId: a.id, reports });
  }

  return {
    organizationId,
    windowFrom: windowFrom.toISOString(),
    windowTo: windowTo.toISOString(),
    attempts,
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
