'use server';

import { revalidatePath } from 'next/cache';
import type { MessageChannel } from '@prisma/client';
import { InvalidInputError, ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission, resolveAppointmentResource } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { runReminderTick, sendNowForSession } from '@/lib/messaging/reminders';
import { runRetentionTick } from '@/lib/gdpr';
import { MIN_REMINDER_LEAD_HOURS } from '@/lib/messaging/reminders';

// Server Actions used by the /reminders page. Each mirrors an API concept and
// revalidates the page so the message-log table + upcoming list refresh.

async function ctxFor(permission: string, module: string) {
  const ctx = await requireAuthContext();
  requirePermission(ctx, permission, { organizationId: ctx.activeOrganizationId! }, module);
  return ctxToSession(ctx);
}

/**
 * Who may change what every customer of the organisation is sent, and when.
 *
 * Reminder templates (one message_template row per organisation and channel)
 * and the lead time (organizations.reminder_lead_hours) are ORGANISATION-WIDE
 * configuration. These two actions used to be gated by `booking.update` in list
 * mode — the permission for editing a booking — so any PROVIDER or FRONT_DESK
 * could rewrite the text sent to every customer of the organisation, or shorten
 * the lead time for all of them (scoped-RBAC audit §7).
 *
 * `org.settings.update:org` is the key spec §6.2 gives organisation settings
 * (ORG_OWNER, ORG_ADMIN), and the one the retention and tick actions on this
 * same page already require. It is passed fully qualified, so a `:branch` grant
 * (BRANCH_MANAGER's org.settings.update:branch) does not reach org-wide
 * configuration through can()'s scope walk.
 */
const REMINDER_SETTINGS_PERMISSION = 'org.settings.update:org';

export async function saveTemplateAction(fd: FormData) {
  const session = await ctxFor(REMINDER_SETTINGS_PERMISSION, 'reminders');
  const channel = String(fd.get('channel') ?? '') as MessageChannel;
  const body = String(fd.get('body') ?? '').trim();
  if (channel !== 'sms' && channel !== 'email') {
    throw new InvalidInputError('channel must be sms or email');
  }
  if (!body) throw new InvalidInputError('body cannot be empty');

  await withOrg(session.organizationId, async (tx) => {
    const existing = await tx.messageTemplate.findFirst({
      where: { organizationId: session.organizationId, channel },
      select: { id: true },
    });
    let templateId: string;
    if (existing) {
      await tx.messageTemplate.update({
        where: { id: existing.id },
        data: { body, updatedAt: new Date() },
      });
      templateId = existing.id;
    } else {
      const created = await tx.messageTemplate.create({
        data: { organizationId: session.organizationId, channel, body },
        select: { id: true },
      });
      templateId = created.id;
    }
    await writeAudit(tx, session, 'update', 'message_template', templateId, { channel });
  });
  revalidatePath('/reminders');
}

export async function saveLeadHoursAction(fd: FormData) {
  const session = await ctxFor(REMINDER_SETTINGS_PERMISSION, 'reminders');
  const raw = String(fd.get('hours') ?? '');
  const hours = Number(raw);
  // The floor is not cosmetic. The reminder window is sliding —
  // [now, now + leadHours] recomputed each tick — so a lead time shorter than
  // the gap between ticks means appointments are never reminded at all, not
  // merely reminded late. GitHub's measured worst-case delivery gap on this
  // account is 4h40m against a declared 15 minutes (R-08), and accepting
  // `hours = 1` here silently armed that. See MIN_REMINDER_LEAD_HOURS.
  if (!Number.isInteger(hours) || hours < MIN_REMINDER_LEAD_HOURS || hours > 168) {
    throw new InvalidInputError(
      `hours must be an integer between ${MIN_REMINDER_LEAD_HOURS} and 168. ` +
        'Below that, scheduled delivery cannot guarantee a tick inside the window ' +
        'and reminders would be silently skipped rather than merely late.',
    );
  }
  await withOrg(session.organizationId, async (tx) => {
    // The audit row must name the value THIS write replaced. A plain read in
    // the same transaction does not guarantee that: under READ COMMITTED it
    // takes no lock, so two concurrent saves can both read 24, and the second
    // then records `previous: 24` for a value the first had already replaced.
    // Locking the row first makes read-then-write one step; a concurrent save
    // waits here and then reads what the first one committed.
    await tx.$executeRaw`SELECT id FROM organizations WHERE id = ${session.organizationId}::uuid FOR UPDATE`;
    const before = await tx.organization.findUnique({
      where: { id: session.organizationId },
      select: { reminderLeadHours: true },
    });
    await tx.organization.update({
      where: { id: session.organizationId },
      data: { reminderLeadHours: hours },
    });
    // This change decides, for every customer of the organisation, whether a
    // reminder arrives at all (MIN_REMINDER_LEAD_HOURS), and it was the one
    // settings write on this page with no audit row.
    await writeAudit(tx, session, 'update', 'organization', session.organizationId, {
      setting: 'reminderLeadHours',
      hours,
      previous: before?.reminderLeadHours ?? null,
    });
  });
  revalidatePath('/reminders');
}

export async function sendNowAction(fd: FormData) {
  const ctx = await requireAuthContext();
  const appointmentId = String(fd.get('appointmentId') ?? '');
  if (!appointmentId) throw new InvalidInputError('appointmentId is required');
  // U-06: AUTHORISE THE APPOINTMENT, NOT THE ORGANISATION.
  //
  // This used ctxFor('booking.update'), i.e. `{ organizationId }` only, then
  // sent for whatever id arrived. Naming no resource is can()'s list mode,
  // which grants `:own` — so a PROVIDER could fire customer reminders for ANY
  // appointment in the organisation. Same resolver as
  // POST /api/reminders/send-now: owner and branch from one row, and an id
  // that does not resolve in this organisation is refused as not-found — after
  // a coarse gate, so a caller with no booking.update at all learns nothing.
  requirePermission(
    ctx,
    'booking.update',
    { organizationId: ctx.activeOrganizationId! },
    'reminders',
  );
  const resource = await resolveAppointmentResource(appointmentId, ctx.activeOrganizationId!);
  if (!resource) throw new InvalidInputError('appointment not found');
  requirePermission(ctx, 'booking.update', resource, 'reminders');
  await sendNowForSession(ctxToSession(ctx), appointmentId);
  revalidatePath('/reminders');
}

export async function runTickAction() {
  const session = await ctxFor('org.settings.update:org', 'reminders');
  await runReminderTick(session.organizationId);
  revalidatePath('/reminders');
}

export async function saveRetentionYearsAction(fd: FormData) {
  const session = await ctxFor('org.settings.update:org', 'reminders');
  const raw = String(fd.get('years') ?? '');
  const years = Number(raw);
  if (!Number.isInteger(years) || years < 1 || years > 30) {
    throw new InvalidInputError('years must be an integer between 1 and 30');
  }
  await withOrg(session.organizationId, async (tx) => {
    await tx.organization.update({
      where: { id: session.organizationId },
      data: { customerRetentionYears: years },
    });
    await writeAudit(tx, session, 'update', 'organization', session.organizationId, {
      setting: 'customerRetentionYears',
      years,
    });
  });
  revalidatePath('/reminders');
}

export async function runRetentionTickAction() {
  const session = await ctxFor('client.export', 'reminders');
  await runRetentionTick(session.organizationId);
  revalidatePath('/reminders');
  revalidatePath('/patients');
}
