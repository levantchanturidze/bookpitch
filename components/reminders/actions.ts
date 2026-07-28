'use server';

import { revalidatePath } from 'next/cache';
import type { MessageChannel } from '@prisma/client';
import { InvalidInputError, ctxToSession } from '@/lib/auth';
import { requireAuthContext, requirePermission } from '@/lib/rbac';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { runReminderTick, sendNowForSession } from '@/lib/messaging/reminders';
import { runRetentionTick } from '@/lib/gdpr';

// Server Actions used by the /reminders page. Each mirrors an API concept and
// revalidates the page so the message-log table + upcoming list refresh.

async function ctxFor(permission: string, module: string) {
  const ctx = await requireAuthContext();
  requirePermission(ctx, permission, { organizationId: ctx.activeOrganizationId! }, module);
  return ctxToSession(ctx);
}

export async function saveTemplateAction(fd: FormData) {
  const session = await ctxFor('booking.update', 'reminders');
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
    if (existing) {
      await tx.messageTemplate.update({
        where: { id: existing.id },
        data: { body, updatedAt: new Date() },
      });
    } else {
      await tx.messageTemplate.create({
        data: { organizationId: session.organizationId, channel, body },
      });
    }
    await writeAudit(tx, session, 'update', 'appointment', null, {
      messageTemplate: { channel },
    });
  });
  revalidatePath('/reminders');
}

export async function saveLeadHoursAction(fd: FormData) {
  const session = await ctxFor('booking.update', 'reminders');
  const raw = String(fd.get('hours') ?? '');
  const hours = Number(raw);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    throw new InvalidInputError('hours must be an integer between 1 and 168');
  }
  await withOrg(session.organizationId, async (tx) => {
    await tx.organization.update({
      where: { id: session.organizationId },
      data: { reminderLeadHours: hours },
    });
  });
  revalidatePath('/reminders');
}

export async function sendNowAction(fd: FormData) {
  const session = await ctxFor('booking.update', 'reminders');
  const appointmentId = String(fd.get('appointmentId') ?? '');
  if (!appointmentId) throw new InvalidInputError('appointmentId is required');
  await sendNowForSession(session, appointmentId);
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
    await writeAudit(tx, session, 'update', 'customer', null, {
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
