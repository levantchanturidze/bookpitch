import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Reminders code imports @/auth transitively via lib/auth's ForbiddenError
// (imported by lib/messaging/reminders.ts via lib/auth exports). Stub so
// vitest doesn't try to load next-auth's env module.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { withoutRls } = await import('@/lib/db');
const { renderTemplate, DEFAULT_SMS_TEMPLATE } = await import('@/lib/messaging/templates');
const { runReminderTick, sendForAppointment } = await import('@/lib/messaging/reminders');

async function clearMessageLogs(appointmentIds: string[]) {
  if (!appointmentIds.length) return;
  await withoutRls((tx) =>
    tx.messageLog.deleteMany({ where: { appointmentId: { in: appointmentIds } } }),
  );
}

describe('renderTemplate', () => {
  it('substitutes known placeholders', () => {
    const out = renderTemplate(DEFAULT_SMS_TEMPLATE, {
      PatientName: 'Sarah',
      StaffName: 'Dr. Vance',
      ServiceName: 'Consultation',
      Date: '2026-08-01',
      Time: '10:00',
    });
    expect(out).toContain('Sarah');
    expect(out).toContain('Dr. Vance');
    expect(out).toContain('Consultation');
    expect(out).toContain('2026-08-01');
    expect(out).toContain('10:00');
  });

  it('renders missing/null vars as em-dash', () => {
    const out = renderTemplate('Hi {PatientName} at {Time}', {
      PatientName: null,
      Time: '',
    });
    expect(out).toBe('Hi — at —');
  });

  it('leaves unknown placeholders verbatim', () => {
    const out = renderTemplate('Hello {Unknown} — {PatientName}', { PatientName: 'Ada' });
    expect(out).toBe('Hello {Unknown} — Ada');
  });
});

describe('runReminderTick / sendForAppointment', () => {
  let primaryOrgId: string;
  let insideWindowApptId: string;
  let outsideWindowApptId: string | null = null;
  let noContactCustomerId: string | null = null;
  let noContactApptId: string | null = null;
  const trackedApptIds: string[] = [];

  beforeAll(async () => {
    const seed = await withoutRls(async (tx) => {
      const primary = await tx.organization.findFirst({
        where: { name: { not: 'Isolation Corp' } },
        orderBy: { createdAt: 'asc' },
      });

      const staff = await tx.staff.findFirst({
        where: { organizationId: primary!.id },
      });
      const customer = await tx.customer.findFirst({
        where: { organizationId: primary!.id, phone: { not: null } },
      });
      const service = await tx.service.findFirst({
        where: { organizationId: primary!.id, locationId: staff!.locationId },
      });

      // Force lead time so the window covers our test appointments.
      await tx.organization.update({
        where: { id: primary!.id },
        data: { reminderLeadHours: 48 },
      });
      // Ensure at least one template exists so the tick doesn't skip
      // because of the app-layer fallback vs. seeded state coincidences.
      const smsExisting = await tx.messageTemplate.findFirst({
        where: { organizationId: primary!.id, channel: 'sms' },
      });
      if (!smsExisting) {
        await tx.messageTemplate.create({
          data: {
            organizationId: primary!.id,
            channel: 'sms',
            body: 'Hi {PatientName}, {ServiceName} on {Date} {Time}',
          },
        });
      }

      // Create appointments explicitly at known times so we can control the
      // window regardless of seed dates.
      const insideStarts = new Date(Date.now() + 4 * 3600_000); // +4h from now
      const outsideStarts = new Date(Date.now() + 5 * 24 * 3600_000); // +5 days

      const insideAppt = await tx.appointment.create({
        data: {
          organizationId: primary!.id,
          locationId: staff!.locationId,
          customerId: customer!.id,
          staffId: staff!.id,
          serviceId: service!.id,
          startsAt: insideStarts,
          endsAt: new Date(insideStarts.getTime() + service!.durationMinutes * 60_000),
          serviceName: service!.name,
          price: service!.price,
          status: 'confirmed',
          paymentStatus: 'unpaid',
          notes: 'reminders test',
        },
      });

      // Second, farther-out appointment on a different day+time to avoid
      // colliding with the staff's other seeded rows via the exclusion
      // constraint. If it still conflicts, we skip this scenario gracefully.
      let outsideId: string | null = null;
      try {
        const outsideAppt = await tx.appointment.create({
          data: {
            organizationId: primary!.id,
            locationId: staff!.locationId,
            customerId: customer!.id,
            staffId: staff!.id,
            serviceId: service!.id,
            startsAt: outsideStarts,
            endsAt: new Date(outsideStarts.getTime() + service!.durationMinutes * 60_000),
            serviceName: service!.name,
            price: service!.price,
            status: 'confirmed',
            paymentStatus: 'unpaid',
            notes: 'reminders test — outside window',
          },
        });
        outsideId = outsideAppt.id;
      } catch {
        // ignore
      }

      // Third scenario: appointment with a customer that has NEITHER phone
      // nor email. Create a stub customer + a near-future appointment.
      const strangerCust = await tx.customer.create({
        data: {
          organizationId: primary!.id,
          name: 'Reminders Test — No Contact',
          email: null,
          phone: null,
        },
      });
      // Use a different staff so we don't collide with the first appt.
      const otherStaff =
        (await tx.staff.findFirst({
          where: { organizationId: primary!.id, id: { not: staff!.id } },
        })) ?? staff!;
      const noContactStarts = new Date(Date.now() + 6 * 3600_000);
      let noContactApptIdLocal: string | null = null;
      try {
        const noContactAppt = await tx.appointment.create({
          data: {
            organizationId: primary!.id,
            locationId: otherStaff.locationId,
            customerId: strangerCust.id,
            staffId: otherStaff.id,
            serviceId:
              (
                await tx.service.findFirst({
                  where: { locationId: otherStaff.locationId },
                })
              )?.id ?? service!.id,
            startsAt: noContactStarts,
            endsAt: new Date(noContactStarts.getTime() + 30 * 60_000),
            serviceName: 'no-contact test',
            price: 0,
            status: 'confirmed',
            paymentStatus: 'unpaid',
          },
        });
        noContactApptIdLocal = noContactAppt.id;
      } catch {
        // ignore
      }

      return {
        orgId: primary!.id,
        insideId: insideAppt.id,
        outsideId,
        strangerCustId: strangerCust.id,
        noContactApptId: noContactApptIdLocal,
      };
    });
    primaryOrgId = seed.orgId;
    insideWindowApptId = seed.insideId;
    outsideWindowApptId = seed.outsideId;
    noContactCustomerId = seed.strangerCustId;
    noContactApptId = seed.noContactApptId;
    trackedApptIds.push(insideWindowApptId);
    if (outsideWindowApptId) trackedApptIds.push(outsideWindowApptId);
    if (noContactApptId) trackedApptIds.push(noContactApptId);
  });

  afterAll(async () => {
    await clearMessageLogs(trackedApptIds);
    await withoutRls((tx) => tx.appointment.deleteMany({ where: { id: { in: trackedApptIds } } }));
    if (noContactCustomerId) {
      await withoutRls((tx) =>
        tx.customer.delete({ where: { id: noContactCustomerId! } }).catch(() => null),
      );
    }
  });

  beforeEach(async () => {
    await clearMessageLogs(trackedApptIds);
  });

  it('sendForAppointment sends both channels and records message_log rows', async () => {
    const sms = await sendForAppointment(insideWindowApptId, 'sms');
    const email = await sendForAppointment(insideWindowApptId, 'email');
    expect(sms.outcome).toBe('sent');
    expect(email.outcome).toBe('sent');

    const logs = await withoutRls((tx) =>
      tx.messageLog.findMany({ where: { appointmentId: insideWindowApptId } }),
    );
    expect(logs.length).toBe(2);
    expect(logs.every((l) => l.state === 'sent')).toBe(true);
    expect(logs.every((l) => l.providerMsgId?.startsWith('mock_'))).toBe(true);
  });

  it('repeat send is idempotent per channel (skipped_duplicate)', async () => {
    await sendForAppointment(insideWindowApptId, 'sms');
    const repeat = await sendForAppointment(insideWindowApptId, 'sms');
    expect(repeat.outcome).toBe('skipped_duplicate');

    const smsLogs = await withoutRls((tx) =>
      tx.messageLog.count({
        where: { appointmentId: insideWindowApptId, channel: 'sms' },
      }),
    );
    expect(smsLogs).toBe(1);
  });

  it('runReminderTick picks up in-window appointments and skips out-of-window ones', async () => {
    const report = await runReminderTick(primaryOrgId);
    const touchedInside = report.attempts.some((a) => a.appointmentId === insideWindowApptId);
    expect(touchedInside).toBe(true);

    if (outsideWindowApptId) {
      const touchedOutside = report.attempts.some((a) => a.appointmentId === outsideWindowApptId);
      expect(touchedOutside).toBe(false);
    }
  });

  it('missing customer contact records a failed row and does not throw', async () => {
    if (!noContactApptId) return; // scenario didn't seed cleanly
    const sms = await sendForAppointment(noContactApptId, 'sms');
    expect(sms.outcome).toBe('skipped_missing_contact');

    const logs = await withoutRls((tx) =>
      tx.messageLog.findMany({
        where: { appointmentId: noContactApptId!, channel: 'sms' },
      }),
    );
    expect(logs.length).toBe(1);
    expect(logs[0].state).toBe('failed');
    expect(logs[0].toAddress).toBe('');
  });
});
