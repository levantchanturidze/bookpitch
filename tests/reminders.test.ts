import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

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
const { runReminderTick, sendForAppointment, activeChannels } =
  await import('@/lib/messaging/reminders');

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

  // Incident #90. This test used to assert `state === 'failed'`, which is the
  // behaviour that helped cause it: a customer with no phone number and a dead
  // SMS gateway produced identical rows, so the operator could not tell a data
  // gap from an outage — and because `failed` is deliberately OUTSIDE the dedup
  // set, every tick for the whole lead window wrote another one.
  //
  // The assertion is kept and strengthened rather than relaxed: same entry
  // point, same outcome code, and now three properties the old test did not
  // check at all.
  it('missing customer contact records a SKIPPED row, deduped, and does not throw', async () => {
    if (!noContactApptId) return; // scenario didn't seed cleanly
    const sms = await sendForAppointment(noContactApptId, 'sms');
    expect(sms.outcome).toBe('skipped_missing_contact');

    const logs = await withoutRls((tx) =>
      tx.messageLog.findMany({
        where: { appointmentId: noContactApptId!, channel: 'sms' },
      }),
    );
    expect(logs.length).toBe(1);
    // A data condition, not a provider failure.
    expect(logs[0].state).toBe('skipped');
    expect(logs[0].toAddress).toBe('');
  });

  it('repeated ticks do not accumulate missing-contact rows without bound', async () => {
    if (!noContactApptId) return;
    // The unbounded-growth complement. Before the fix this wrote one row per
    // tick, for as long as the appointment sat inside the lead window.
    for (let i = 0; i < 4; i += 1) {
      const r = await sendForAppointment(noContactApptId, 'sms');
      expect(r.outcome).toBe('skipped_missing_contact');
    }
    const logs = await withoutRls((tx) =>
      tx.messageLog.findMany({ where: { appointmentId: noContactApptId!, channel: 'sms' } }),
    );
    expect(logs.length).toBe(1);
  });

  it('a skipped row does NOT block a real send once contact details are added', async () => {
    if (!noContactApptId) return;
    // The other half of the dedup decision, and the reason `skipped` is deduped
    // at the write site rather than inside alreadyReminded(): the skip explains
    // the silence, it must never become the reason for it.
    await sendForAppointment(noContactApptId, 'sms'); // leaves a skipped row

    const appt = await withoutRls((tx) =>
      tx.appointment.findUnique({
        where: { id: noContactApptId! },
        select: { customerId: true },
      }),
    );
    await withoutRls((tx) =>
      tx.customer.update({
        where: { id: appt!.customerId },
        data: { phone: '+995500000001' },
      }),
    );

    const after = await sendForAppointment(noContactApptId, 'sms');
    expect(after.outcome).toBe('sent');

    const logs = await withoutRls((tx) =>
      tx.messageLog.findMany({ where: { appointmentId: noContactApptId!, channel: 'sms' } }),
    );
    expect(logs.map((l) => l.state).sort()).toEqual(['sent', 'skipped']);
  });

  // ---- the sender asks the policy module, not a private list ----------------
  //
  // The policy being correct is worth nothing if runReminderTick() still holds
  // its own array — that WAS incident #90. activeChannels() is the function the
  // scheduled tick and "Send now" both call, so this asserts the thing that
  // runs rather than a parallel copy of the rule.
  //
  // It lives in this file because importing lib/messaging/reminders from a
  // file without the DB harness breaks next-auth module resolution (the same
  // constraint tests/reminder-gap-recovery.test.ts documents).
  describe('the reminder sender consumes the channel policy', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('dials ONLY the live channel when SMS is deferred in production', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('EMAIL_PROVIDER', 'resend');
      vi.stubEnv('SMS_PROVIDER', 'mock');
      // getSmsProvider() throws on mock in production. A hard-coded
      // ['sms','email'] loop would dial it here and manufacture the failure row
      // that made the UAT appointment look unreminded.
      expect(activeChannels()).toEqual(['email']);
    });

    it('dials both once SMS is really configured', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('EMAIL_PROVIDER', 'resend');
      vi.stubEnv('SMS_PROVIDER', 'smsoffice');
      expect(activeChannels().slice().sort()).toEqual(['email', 'sms']);
    });
  });
});
