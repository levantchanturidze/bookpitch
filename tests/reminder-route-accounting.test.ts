import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Reminders code reaches @/auth transitively; next-auth's env module cannot
// resolve next/server under vitest. Same stub as tests/reminders.test.ts.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/cron/reminders/route';
import { unsafePrismaAdmin, withoutRls } from '@/lib/db';
import { REMINDER_CLAIM_TTL_MINUTES } from '@/lib/messaging/reminders';

// -----------------------------------------------------------------------------
// §5 and §6 — what the reminders ENDPOINT reports, and what a crash leaves behind.
//
// classifyRun() was already tested. That is not the same as testing the route,
// and the route was where the accounting was wrong:
//
//   * it counted an organization as processed whenever runReminderTick()
//     RESOLVED — and it resolves normally when every provider send fails,
//     because sendForAppointment() returns a report rather than throwing. Ten
//     organizations where nothing reached anyone was ten successes, HTTP 200
//     and a healthy heartbeat;
//   * a truncated tick — appointments past the per-tick limit, never reached —
//     was also a success.
//
// And §6: claim() commits a message_log row as `queued` BEFORE the provider
// call, while alreadyReminded() treated `queued` as proof of delivery. A crash
// in between produced a reminder that was never sent, could never be retried
// (the stale row deduped every later attempt), and was invisible to the
// missed-reminder metric, which also counted `queued` as delivered. Silent from
// all three directions at once.
// -----------------------------------------------------------------------------

const SECRET = 'reminder-route-accounting-secret';
const FIXTURE_ORG = 'Reminder Route Fixture (accounting)';

let orgId: string;
let apptId: string;
let previousSecret: string | undefined;

function req(): NextRequest {
  return {
    headers: { get: (k: string) => (k === 'authorization' ? `Bearer ${SECRET}` : null) },
  } as unknown as NextRequest;
}

describe('the reminders route reports channel-level truth', () => {
  beforeAll(async () => {
    previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;

    const existing = await withoutRls((tx) =>
      tx.organization.findFirst({ where: { name: FIXTURE_ORG }, select: { id: true } }),
    );
    orgId =
      existing?.id ??
      (
        await withoutRls((tx) =>
          tx.organization.create({
            // Archived: it has no owner, and a live ownerless org breaks the
            // ownership invariant rbac-backfill asserts. It also cannot be
            // deleted, because audit_log holds a foreign key and is append-only.
            data: {
              name: FIXTURE_ORG,
              vertical: 'clinic',
              reminderLeadHours: 24,
              status: 'archived',
            },
            select: { id: true },
          }),
        )
      ).id;

    const loc =
      (await withoutRls((tx) =>
        tx.location.findFirst({ where: { organizationId: orgId }, select: { id: true } }),
      )) ??
      (await withoutRls((tx) =>
        tx.location.create({
          data: { organizationId: orgId, name: 'Main', type: 'clinic', timezone: 'UTC' },
          select: { id: true },
        }),
      ));
    const staff =
      (await withoutRls((tx) =>
        tx.staff.findFirst({ where: { organizationId: orgId }, select: { id: true } }),
      )) ??
      (await withoutRls((tx) =>
        tx.staff.create({
          data: { organizationId: orgId, locationId: loc.id, name: 'S', roleTitle: 'doc' },
          select: { id: true },
        }),
      ));
    const svc =
      (await withoutRls((tx) =>
        tx.service.findFirst({ where: { organizationId: orgId }, select: { id: true } }),
      )) ??
      (await withoutRls((tx) =>
        tx.service.create({
          data: {
            organizationId: orgId,
            locationId: loc.id,
            name: 'Svc',
            price: 1,
            durationMinutes: 30,
          },
          select: { id: true },
        }),
      ));
    const cust =
      (await withoutRls((tx) =>
        tx.customer.findFirst({ where: { organizationId: orgId }, select: { id: true } }),
      )) ??
      (await withoutRls((tx) =>
        tx.customer.create({
          data: { organizationId: orgId, name: 'Route Fixture', email: 'route@invalid.test' },
          select: { id: true },
        }),
      ));

    await withoutRls(async (tx) => {
      await tx.messageLog.deleteMany({ where: { organizationId: orgId } });
      await tx.appointment.deleteMany({ where: { organizationId: orgId } });
    });
    const appt = await withoutRls((tx) =>
      tx.appointment.create({
        data: {
          organizationId: orgId,
          locationId: loc.id,
          customerId: cust.id,
          staffId: staff.id,
          serviceId: svc.id,
          serviceName: 'Route fixture',
          price: 1,
          startsAt: new Date(Date.now() + 6 * 3_600_000),
          endsAt: new Date(Date.now() + 6.5 * 3_600_000),
          status: 'confirmed',
        },
        select: { id: true },
      }),
    );
    apptId = appt.id;
  });

  beforeEach(async () => {
    await withoutRls((tx) => tx.messageLog.deleteMany({ where: { organizationId: orgId } }));
  });

  it('reports per-channel counts rather than an organization tally', async () => {
    const res = await POST(req());
    const body = await res.json();
    expect(body.channels).toBeDefined();
    for (const k of [
      'expected',
      'sent',
      'duplicates',
      'missingContact',
      'rateLimited',
      'providerFailed',
      'unprocessed',
    ]) {
      expect(typeof body.channels[k], `channels.${k}`).toBe('number');
    }
  });

  it('THE REGRESSION: provider failures are not a success', async () => {
    // The mock SMS provider is unavailable in this environment, so at least
    // one channel fails for real. Under the old accounting the organization
    // resolved and the route answered 200 with a healthy heartbeat.
    const res = await POST(req());
    const body = await res.json();
    if (body.channels.providerFailed > 0) {
      expect(res.status, 'a failed send must not answer 200').toBe(500);
      expect(body.ok).toBe(false);
      expect(body.outcome).not.toBe('success');
    } else {
      // If every channel really did settle, the run may legitimately be a
      // success — but then it must not claim failures either.
      expect(body.channels.providerFailed).toBe(0);
    }
  });

  it('never returns a raw provider error or any address', async () => {
    const res = await POST(req());
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/route@invalid\.test/);
    // The response carries counts and identifiers, not error strings.
    expect(text).not.toMatch(/stack|ECONNREFUSED|Error:/i);
  });

  it('rejects an unauthenticated call before doing any work', async () => {
    const bad = { headers: { get: () => 'Bearer wrong' } } as unknown as NextRequest;
    const res = await POST(bad);
    expect(res.status).toBe(401);
  });
});

// -----------------------------------------------------------------------------
// §6 — the crash window between claim() and settle.
// -----------------------------------------------------------------------------
describe('a crash after claiming does not silence the reminder forever', () => {
  it('a STALE queued row no longer blocks a retry, and is settled as failed', async () => {
    // Simulate the crash: a queued row older than the claim lease, with no
    // provider call ever made.
    await withoutRls((tx) => tx.messageLog.deleteMany({ where: { organizationId: orgId } }));
    const stale = await withoutRls((tx) =>
      tx.messageLog.create({
        data: {
          organizationId: orgId,
          appointmentId: apptId,
          channel: 'email',
          toAddress: 'route@invalid.test',
          body: 'abandoned claim',
          state: 'queued',
        },
        select: { id: true },
      }),
    );
    await unsafePrismaAdmin.$executeRawUnsafe(
      `UPDATE message_log SET created_at = NOW() - make_interval(mins => $1) WHERE id = $2::uuid`,
      REMINDER_CLAIM_TTL_MINUTES + 5,
      stale.id,
    );

    await POST(req());

    const after = await withoutRls((tx) =>
      tx.messageLog.findUnique({ where: { id: stale.id }, select: { state: true } }),
    );
    expect(after?.state, 'an abandoned claim must be settled, not left queued').toBe('failed');

    // …and a fresh attempt was made rather than deduped away.
    const attempts = await withoutRls((tx) =>
      tx.messageLog.count({ where: { appointmentId: apptId, channel: 'email' } }),
    );
    expect(attempts, 'the reminder must be retried past the abandoned claim').toBeGreaterThan(1);
  });

  it('a FRESH queued row is respected — a live worker is not stolen from', async () => {
    await withoutRls((tx) => tx.messageLog.deleteMany({ where: { organizationId: orgId } }));
    await withoutRls((tx) =>
      tx.messageLog.create({
        data: {
          organizationId: orgId,
          appointmentId: apptId,
          channel: 'email',
          toAddress: 'route@invalid.test',
          body: 'live claim',
          state: 'queued',
        },
      }),
    );

    await POST(req());

    const rows = await withoutRls((tx) =>
      tx.messageLog.findMany({
        where: { appointmentId: apptId, channel: 'email' },
        select: { state: true },
      }),
    );
    expect(rows, 'a live claim must not be duplicated').toHaveLength(1);
    expect(rows[0].state).toBe('queued');
  });

  it('a sent row still dedupes permanently, however old', async () => {
    // The lease applies to CLAIMS, not to deliveries. An old `sent` row means
    // the customer already got the reminder.
    await withoutRls((tx) => tx.messageLog.deleteMany({ where: { organizationId: orgId } }));
    const sent = await withoutRls((tx) =>
      tx.messageLog.create({
        data: {
          organizationId: orgId,
          appointmentId: apptId,
          channel: 'email',
          toAddress: 'route@invalid.test',
          body: 'delivered',
          state: 'sent',
        },
        select: { id: true },
      }),
    );
    await unsafePrismaAdmin.$executeRawUnsafe(
      `UPDATE message_log SET created_at = NOW() - interval '30 days' WHERE id = $1::uuid`,
      sent.id,
    );

    await POST(req());

    const emails = await withoutRls((tx) =>
      tx.messageLog.count({ where: { appointmentId: apptId, channel: 'email' } }),
    );
    expect(emails, 'an old delivered reminder must not be sent again').toBe(1);
  });
});

// File-scope teardown. It was inside the first describe, which meant the
// appointment every later test depends on was deleted before they ran.
afterAll(async () => {
  if (previousSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousSecret;
  if (!orgId) return;
  await withoutRls(async (tx) => {
    await tx.messageLog.deleteMany({ where: { organizationId: orgId } });
    await tx.appointment.deleteMany({ where: { organizationId: orgId } });
  });
});
