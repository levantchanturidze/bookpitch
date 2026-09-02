import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Reminders code reaches @/auth transitively (lib/messaging/reminders imports
// lib/auth for ForbiddenError), and next-auth's env module cannot resolve
// next/server under vitest. Same stub as tests/reminders.test.ts.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { unsafePrismaAdmin, withoutRls } from '@/lib/db';
import { runReminderTick } from '@/lib/messaging/reminders';
import { collectOpsMetrics } from '@/lib/ops-metrics';

// -----------------------------------------------------------------------------
// §6 — what a scheduler gap actually does to reminders.
//
// The reminder window is a SLIDING [now, now + reminderLeadHours], recomputed
// every tick. Two consequences that are easy to get backwards:
//
//   FUTURE appointments are self-healing. If a tick is missed, the next tick's
//   window still contains every appointment that has not started yet, because
//   the window is recomputed from the new `now`. A gap shorter than the lead
//   time costs nothing for them.
//
//   An appointment that STARTS DURING the gap is lost permanently. It leaves
//   the window and no later tick can reach it. There is no catch-up that helps:
//   by the time anything notices, the appointment has begun, and sending "your
//   appointment is in 24 hours" afterwards would be worse than silence.
//
// So the engineering answer is not a retry — it is that the second case must
// be VISIBLE. Every other signal can be green while it happens: the heartbeat
// is fresh, the cron run succeeded, the workflow concluded success, and a
// customer was not reminded.
//
// These tests prove both halves: no duplicates when a gap causes re-processing,
// and a non-zero count when an appointment was genuinely missed. The monitor
// side of the same check lives in tests/cron-outcome.test.ts — importing both
// lib/messaging/reminders and the monitor script in one file breaks module
// resolution for next-auth.
// -----------------------------------------------------------------------------

// A STABLE name, reused across runs. The organization cannot be deleted in
// afterAll: audit_log holds a foreign key to it and is append-only by design
// (CLAUDE.md invariant 3), so a fresh org per run would accumulate forever and
// perturb any test that counts organizations. Its appointments and messages
// are cleaned up instead.
const FIXTURE_ORG = 'Gap Fixture Org (reminder-gap-recovery)';
let orgId: string;
let locationId: string;
let staffId: string;
let serviceId: string;
let customerId: string;

async function makeAppointment(startsAt: Date, createdAt: Date): Promise<string> {
  const appt = await withoutRls((tx) =>
    tx.appointment.create({
      data: {
        organizationId: orgId,
        locationId,
        customerId,
        staffId,
        serviceId,
        serviceName: 'Gap fixture',
        price: 1,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        status: 'confirmed',
      },
      select: { id: true },
    }),
  );
  // created_at defaults to now(); the metric needs it to predate the lead
  // window, which is the difference between "missed" and "booked too late".
  await unsafePrismaAdmin.$executeRawUnsafe(
    `UPDATE appointments SET created_at = $1 WHERE id = $2::uuid`,
    createdAt,
    appt.id,
  );
  return appt.id;
}

describe('reminders after a scheduler gap', () => {
  beforeAll(async () => {
    const existing = await withoutRls((tx) =>
      tx.organization.findFirst({ where: { name: FIXTURE_ORG }, select: { id: true } }),
    );
    const org =
      existing ??
      (await withoutRls((tx) =>
        tx.organization.create({
          data: {
            name: FIXTURE_ORG,
            vertical: 'clinic',
            reminderLeadHours: 24,
            // Archived on purpose. The organization cannot be deleted (see
            // above), and a live org with no owner violates the ownership
            // invariant that tests/rbac-backfill.test.ts asserts — measured:
            // it made "non-archived orgs without owner_user_id" fail. Archived
            // is the honest state for a fixture that exists only to be
            // reminded about; runReminderTick() is called by id and does not
            // filter on status.
            status: 'archived',
          },
          select: { id: true },
        }),
      ));
    orgId = org.id;
    // Keep it archived even if an older run created it live.
    await withoutRls((tx) =>
      tx.organization.update({ where: { id: orgId }, data: { status: 'archived' } }),
    );
    // Start from a clean slate within the reused organization.
    await withoutRls(async (tx) => {
      await tx.messageLog.deleteMany({ where: { organizationId: orgId } });
      await tx.appointment.deleteMany({ where: { organizationId: orgId } });
    });
    locationId = (
      (await withoutRls((tx) =>
        tx.location.findFirst({ where: { organizationId: orgId }, select: { id: true } }),
      )) ??
      (await withoutRls((tx) =>
        tx.location.create({
          data: { organizationId: orgId, name: 'Main', type: 'clinic', timezone: 'UTC' },
          select: { id: true },
        }),
      ))
    ).id;
    staffId = (
      (await withoutRls((tx) =>
        tx.staff.findFirst({ where: { organizationId: orgId }, select: { id: true } }),
      )) ??
      (await withoutRls((tx) =>
        tx.staff.create({
          data: { organizationId: orgId, locationId, name: 'S', roleTitle: 'doc' },
          select: { id: true },
        }),
      ))
    ).id;
    serviceId = (
      (await withoutRls((tx) =>
        tx.service.findFirst({ where: { organizationId: orgId }, select: { id: true } }),
      )) ??
      (await withoutRls((tx) =>
        tx.service.create({
          data: { organizationId: orgId, locationId, name: 'Svc', price: 1, durationMinutes: 30 },
          select: { id: true },
        }),
      ))
    ).id;
    customerId = (
      (await withoutRls((tx) =>
        tx.customer.findFirst({ where: { organizationId: orgId }, select: { id: true } }),
      )) ??
      (await withoutRls((tx) =>
        tx.customer.create({
          data: { organizationId: orgId, name: 'Gap Fixture Patient', email: 'gap@invalid.test' },
          select: { id: true },
        }),
      ))
    ).id;
  });

  afterAll(async () => {
    if (!orgId) return;
    // Appointments and messages only. The organization stays: audit_log
    // references it and is append-only, so deleting it is impossible by
    // design — and that is the invariant working, not a cleanup bug.
    await withoutRls(async (tx) => {
      await tx.messageLog.deleteMany({ where: { organizationId: orgId } });
      await tx.appointment.deleteMany({ where: { organizationId: orgId } });
    });
  });

  it('a future appointment is still caught after a long gap — the window is sliding', async () => {
    // Booked 3 days ago, starts in 6 hours. Pretend no tick has run for 5
    // hours: the next tick's window is [now, now + 24h], which still contains
    // it. This is why a gap shorter than the lead time is not a data-loss bug.
    const id = await makeAppointment(
      new Date(Date.now() + 6 * 3_600_000),
      new Date(Date.now() - 3 * 24 * 3_600_000),
    );
    const report = await runReminderTick(orgId);
    expect(report.attempts.map((a) => a.appointmentId)).toContain(id);
  });

  it('re-running the tick never DELIVERS a second reminder', async () => {
    // The catch-up property depends on re-processing being free. claim() takes
    // FOR UPDATE on the appointment and alreadyReminded() dedupes on
    // (appointment, channel) for rows in queued/sent/delivered.
    //
    // The assertion is deliberately about DELIVERED reminders, not about row
    // count. A send that FAILED is not deduped and is retried on the next
    // tick, which is correct — and measured here: with the mock SMS provider
    // unavailable, three ticks produce three failed sms rows and exactly one
    // sent email. Asserting on raw row count would call that retry a bug.
    await runReminderTick(orgId);
    await runReminderTick(orgId);

    const rows = await withoutRls((tx) =>
      tx.messageLog.findMany({
        where: { organizationId: orgId, state: { in: ['queued', 'sent', 'delivered'] } },
        select: { appointmentId: true, channel: true },
      }),
    );
    const seen = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.appointmentId}:${r.channel}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
    expect(duplicated, 'a customer received the same reminder twice').toEqual([]);
  });

  it('THE UNHEALABLE CASE: an appointment that started during the gap is counted', async () => {
    // Booked well before its lead window, started an hour ago, never reminded.
    // No tick can fix this; the check exists so nobody has to discover it from
    // a customer.
    await makeAppointment(
      new Date(Date.now() - 1 * 3_600_000),
      new Date(Date.now() - 5 * 24 * 3_600_000),
    );
    const metrics = await collectOpsMetrics();
    expect(metrics.cronHeartbeat.unremindedStartedAppointments ?? 0).toBeGreaterThan(0);
  });

  it('an appointment booked INSIDE its own lead window is not counted as missed', async () => {
    // Booked 10 minutes before it started. The lead window never covered it,
    // so no reminder was ever owed and this is not evidence of a scheduler
    // gap. Without this the metric would be permanently non-zero for any
    // clinic that takes walk-ins, and would be ignored.
    const beforeCount =
      (await collectOpsMetrics()).cronHeartbeat.unremindedStartedAppointments ?? 0;
    await makeAppointment(new Date(Date.now() - 30 * 60_000), new Date(Date.now() - 40 * 60_000));
    const afterCount = (await collectOpsMetrics()).cronHeartbeat.unremindedStartedAppointments ?? 0;
    expect(afterCount).toBe(beforeCount);
  });

  it('a cancelled appointment is not counted as missed', async () => {
    const beforeCount =
      (await collectOpsMetrics()).cronHeartbeat.unremindedStartedAppointments ?? 0;
    const id = await makeAppointment(
      new Date(Date.now() - 2 * 3_600_000),
      new Date(Date.now() - 5 * 24 * 3_600_000),
    );
    await withoutRls((tx) =>
      tx.appointment.update({ where: { id }, data: { status: 'cancelled' } }),
    );
    expect((await collectOpsMetrics()).cronHeartbeat.unremindedStartedAppointments ?? 0).toBe(
      beforeCount,
    );
  });
});
