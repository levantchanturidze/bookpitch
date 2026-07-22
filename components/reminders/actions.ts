'use server';

import { revalidatePath } from 'next/cache';
import type { MessageChannel } from '@prisma/client';
import { InvalidInputError, requireRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { runReminderTick, sendNowForSession } from '@/lib/messaging/reminders';

// Server Actions used by the /reminders page. Each mirrors an API concept and
// revalidates the page so the message-log table + upcoming list refresh.

export async function saveTemplateAction(fd: FormData) {
  const session = await requireRole('owner', 'receptionist');
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
  const session = await requireRole('owner', 'receptionist');
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
  const session = await requireRole('owner', 'receptionist');
  const appointmentId = String(fd.get('appointmentId') ?? '');
  if (!appointmentId) throw new InvalidInputError('appointmentId is required');
  await sendNowForSession(session, appointmentId);
  revalidatePath('/reminders');
}

export async function runTickAction() {
  const session = await requireRole('owner');
  await runReminderTick(session.organizationId);
  revalidatePath('/reminders');
}
