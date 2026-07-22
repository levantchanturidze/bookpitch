import { requireRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { loadLocationsForOrg } from '@/lib/active-location';
import RemindersView from '@/components/reminders/RemindersView';

export const metadata = { title: 'Reminders · Bookpitch' };
export const dynamic = 'force-dynamic';

export default async function RemindersPage() {
  const session = await requireRole('owner', 'receptionist');
  const { active } = await loadLocationsForOrg(session.organizationId);

  const data = await withOrg(session.organizationId, async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: session.organizationId },
      select: { reminderLeadHours: true, customerRetentionYears: true },
    });
    const leadHours = org?.reminderLeadHours ?? 24;
    const retentionYears = org?.customerRetentionYears ?? 7;

    const templates = await tx.messageTemplate.findMany({
      where: { organizationId: session.organizationId },
    });
    const smsBody = templates.find((t) => t.channel === 'sms')?.body ?? null;
    const emailBody = templates.find((t) => t.channel === 'email')?.body ?? null;

    const now = new Date();
    const windowTo = new Date(now.getTime() + leadHours * 3600_000);
    const upcomingRows = await tx.appointment.findMany({
      where: {
        locationId: active.id,
        status: { notIn: ['cancelled', 'completed'] },
        startsAt: { gte: now, lte: windowTo },
      },
      include: {
        customer: { select: { name: true, email: true, phone: true } },
        staff: { select: { name: true } },
      },
      orderBy: { startsAt: 'asc' },
    });

    const log = await tx.messageLog.findMany({
      orderBy: [{ createdAt: 'desc' }],
      take: 30,
      include: {
        appointment: {
          include: { customer: { select: { name: true } } },
        },
      },
    });

    return {
      leadHours,
      retentionYears,
      smsBody,
      emailBody,
      upcoming: upcomingRows.map((a) => ({
        id: a.id,
        startsAt: a.startsAt.toISOString(),
        customerName: a.customer.name,
        customerPhone: a.customer.phone,
        customerEmail: a.customer.email,
        serviceName: a.serviceName,
        staffName: a.staff.name,
      })),
      log: log.map((l) => ({
        id: l.id,
        channel: l.channel,
        state: l.state,
        toAddress: l.toAddress,
        providerMsgId: l.providerMsgId,
        sentAt: l.sentAt?.toISOString() ?? null,
        createdAt: l.createdAt.toISOString(),
        appointmentId: l.appointmentId,
        customerName: l.appointment?.customer.name ?? null,
      })),
      sampleAppointment: upcomingRows[0]
        ? {
            PatientName: upcomingRows[0].customer.name,
            StaffName: upcomingRows[0].staff.name,
            ServiceName: upcomingRows[0].serviceName,
            Date: upcomingRows[0].startsAt.toISOString().slice(0, 10),
            Time: upcomingRows[0].startsAt.toISOString().slice(11, 16),
          }
        : {},
    };
  });

  return (
    <RemindersView
      leadHours={data.leadHours}
      retentionYears={data.retentionYears}
      smsBody={data.smsBody}
      emailBody={data.emailBody}
      upcoming={data.upcoming}
      log={data.log}
      sampleVars={data.sampleAppointment}
      canRunTick={session.role === 'owner'}
    />
  );
}
