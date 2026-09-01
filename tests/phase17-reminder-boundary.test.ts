import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import { adminDbUrl } from './helpers/admin-db-url';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// The provider is replaced so a test can run assertions from INSIDE send() —
// which is the only place the "is a transaction still open?" question can be
// asked at the moment that matters.
type SendHook = (to: string, a?: string, b?: string) => Promise<void>;
let smsHook: SendHook = async () => {};
let emailHook: SendHook = async () => {};
let sentCount = 0;

vi.mock('@/lib/messaging', () => ({
  getSmsProvider: () => ({
    name: 'test-sms',
    send: async (to: string, body: string) => {
      await smsHook(to, body);
      sentCount++;
      return { providerMsgId: `test_sms_${sentCount}` };
    },
  }),
  getEmailProvider: () => ({
    name: 'test-email',
    send: async (to: string, subject: string, body: string) => {
      await emailHook(to, subject, body);
      sentCount++;
      return { providerMsgId: `test_email_${sentCount}` };
    },
  }),
}));

const { withoutRls } = await import('@/lib/db');
const { sendForAppointment } = await import('@/lib/messaging/reminders');
const { mapWithConcurrency, cronOrgConcurrency } = await import('@/lib/concurrency');

// -----------------------------------------------------------------------------
// P17-004 / P17-005 — the reminder transaction boundary and bounded fan-out.
//
// The claim these tests defend is not "the code was reorganised". It is "no
// Postgres transaction is open while we are waiting on a third-party HTTP
// call". That is invisible to a normal assertion: the refactor looks the same
// from outside, and a future edit that pulls provider.send() back inside a
// withoutRls block would pass every other test in the suite.
//
// So it is measured directly. During send(), a SEPARATE connection tries to
// take the appointment's row lock with NOWAIT. Postgres raises 55P03
// immediately if another transaction holds it, and succeeds if none does.
// The probe is checked against a deliberately-held lock first, so a probe that
// silently stopped detecting anything cannot pass.
// -----------------------------------------------------------------------------

const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Try to take the appointment's row lock on an independent connection.
 * Resolves true when the row is lockable — i.e. nobody else holds it.
 */
async function rowIsLockable(appointmentId: string): Promise<boolean> {
  const probe = new Client({ connectionString: adminDbUrl() });
  await probe.connect();
  try {
    await probe.query('BEGIN');
    await probe.query('SELECT id FROM appointments WHERE id = $1 FOR UPDATE NOWAIT', [
      appointmentId,
    ]);
    await probe.query('COMMIT');
    return true;
  } catch (err) {
    await probe.query('ROLLBACK').catch(() => {});
    if ((err as { code?: string }).code === LOCK_NOT_AVAILABLE) return false;
    throw err;
  } finally {
    await probe.end().catch(() => {});
  }
}

describe('reminder delivery holds no transaction across the provider call', () => {
  let apptId: string;
  let customerId: string;
  const created: string[] = [];

  beforeAll(async () => {
    const seeded = await withoutRls(async (tx) => {
      const org = await tx.organization.findFirstOrThrow({
        where: { name: { not: 'Isolation Corp' } },
        orderBy: { createdAt: 'asc' },
      });
      const staff = await tx.staff.findFirstOrThrow({ where: { organizationId: org.id } });
      const service = await tx.service.findFirstOrThrow({
        where: { organizationId: org.id, locationId: staff.locationId },
      });
      const customer = await tx.customer.create({
        data: {
          organizationId: org.id,
          name: 'P17 Boundary Test',
          email: 'p17-boundary@bp.test',
          phone: '+995500000017',
        },
      });
      // Far enough out that the seeded schedule cannot collide with it.
      const startsAt = new Date(Date.now() + 37 * 24 * 3600_000);
      const appt = await tx.appointment.create({
        data: {
          organizationId: org.id,
          locationId: staff.locationId,
          customerId: customer.id,
          staffId: staff.id,
          serviceId: service.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + service.durationMinutes * 60_000),
          serviceName: service.name,
          price: service.price,
          status: 'confirmed',
          paymentStatus: 'unpaid',
          notes: 'p17 boundary test',
        },
      });
      return { apptId: appt.id, customerId: customer.id };
    });
    apptId = seeded.apptId;
    customerId = seeded.customerId;
    created.push(apptId);
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.messageLog.deleteMany({ where: { appointmentId: { in: created } } });
      await tx.appointment.deleteMany({ where: { id: { in: created } } });
      await tx.customer.deleteMany({ where: { id: customerId } });
    });
  });

  beforeEach(async () => {
    smsHook = async () => {};
    emailHook = async () => {};
    sentCount = 0;
    await withoutRls((tx) => tx.messageLog.deleteMany({ where: { appointmentId: apptId } }));
  });

  it('CONTROL: the lock probe detects a transaction that IS holding the row', async () => {
    // Without this, "the row was lockable" could mean the probe is broken.
    let observed: boolean | null = null;
    await withoutRls(async (tx) => {
      await tx.$executeRaw`SELECT id FROM appointments WHERE id = ${apptId}::uuid FOR UPDATE`;
      observed = await rowIsLockable(apptId);
    });
    expect(observed).toBe(false);
  });

  it('the appointment row is NOT locked while the SMS provider is being called', async () => {
    let lockableDuringSend: boolean | null = null;
    smsHook = async () => {
      lockableDuringSend = await rowIsLockable(apptId);
    };

    const report = await sendForAppointment(apptId, 'sms');
    expect(report.outcome).toBe('sent');
    expect(lockableDuringSend).toBe(true);
  });

  it('the appointment row is NOT locked while the email provider is being called', async () => {
    let lockableDuringSend: boolean | null = null;
    emailHook = async () => {
      lockableDuringSend = await rowIsLockable(apptId);
    };

    const report = await sendForAppointment(apptId, 'email');
    expect(report.outcome).toBe('sent');
    expect(lockableDuringSend).toBe(true);
  });

  it('a slow provider does not keep a transaction open for its duration', async () => {
    let lockableLate: boolean | null = null;
    smsHook = async () => {
      await new Promise((r) => setTimeout(r, 250));
      lockableLate = await rowIsLockable(apptId);
    };
    const report = await sendForAppointment(apptId, 'sms');
    expect(report.outcome).toBe('sent');
    expect(lockableLate).toBe(true);
  });
});

describe('provider failure modes', () => {
  let apptId: string;
  let customerId: string;

  beforeAll(async () => {
    const seeded = await withoutRls(async (tx) => {
      const org = await tx.organization.findFirstOrThrow({
        where: { name: { not: 'Isolation Corp' } },
        orderBy: { createdAt: 'asc' },
      });
      const staff = await tx.staff.findFirstOrThrow({ where: { organizationId: org.id } });
      const service = await tx.service.findFirstOrThrow({
        where: { organizationId: org.id, locationId: staff.locationId },
      });
      const customer = await tx.customer.create({
        data: {
          organizationId: org.id,
          name: 'P17 Failure Test',
          email: 'p17-failure@bp.test',
          phone: '+995500000018',
        },
      });
      const startsAt = new Date(Date.now() + 41 * 24 * 3600_000);
      const appt = await tx.appointment.create({
        data: {
          organizationId: org.id,
          locationId: staff.locationId,
          customerId: customer.id,
          staffId: staff.id,
          serviceId: service.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + service.durationMinutes * 60_000),
          serviceName: service.name,
          price: service.price,
          status: 'confirmed',
          paymentStatus: 'unpaid',
        },
      });
      return { apptId: appt.id, customerId: customer.id };
    });
    apptId = seeded.apptId;
    customerId = seeded.customerId;
  });

  afterAll(async () => {
    await withoutRls(async (tx) => {
      await tx.messageLog.deleteMany({ where: { appointmentId: apptId } });
      await tx.appointment.deleteMany({ where: { id: apptId } });
      await tx.customer.deleteMany({ where: { id: customerId } });
    });
  });

  beforeEach(async () => {
    smsHook = async () => {};
    emailHook = async () => {};
    sentCount = 0;
    await withoutRls((tx) => tx.messageLog.deleteMany({ where: { appointmentId: apptId } }));
  });

  it('a provider exception is reported as failed and recorded as failed', async () => {
    smsHook = async () => {
      throw new Error('provider exploded');
    };
    const report = await sendForAppointment(apptId, 'sms');
    expect(report.outcome).toBe('failed');
    expect(report.error).toContain('provider exploded');

    const logs = await withoutRls((tx) =>
      tx.messageLog.findMany({ where: { appointmentId: apptId, channel: 'sms' } }),
    );
    expect(logs.length).toBe(1);
    expect(logs[0].state).toBe('failed');
  });

  it('a provider timeout is reported as failed, not as sent', async () => {
    smsHook = async () => {
      await new Promise((r) => setTimeout(r, 60));
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };
    const report = await sendForAppointment(apptId, 'sms');
    expect(report.outcome).toBe('failed');

    const logs = await withoutRls((tx) =>
      tx.messageLog.findMany({ where: { appointmentId: apptId, channel: 'sms' } }),
    );
    expect(logs.every((l) => l.state === 'failed')).toBe(true);
  });

  it('a failed attempt does not block the retry — the anchor row is not a tombstone', async () => {
    smsHook = async () => {
      throw new Error('transient');
    };
    expect((await sendForAppointment(apptId, 'sms')).outcome).toBe('failed');

    // Second attempt with a healthy provider must go through. If `failed` were
    // in the dedup state set, this would come back skipped_duplicate and the
    // reminder would never be sent.
    smsHook = async () => {};
    const retry = await sendForAppointment(apptId, 'sms');
    expect(retry.outcome).toBe('sent');

    const logs = await withoutRls((tx) =>
      tx.messageLog.findMany({ where: { appointmentId: apptId, channel: 'sms' } }),
    );
    expect(logs.filter((l) => l.state === 'sent').length).toBe(1);
    expect(logs.filter((l) => l.state === 'failed').length).toBe(1);
  });

  it('a successful send is not re-sent — idempotency survives the split', async () => {
    expect((await sendForAppointment(apptId, 'sms')).outcome).toBe('sent');
    expect((await sendForAppointment(apptId, 'sms')).outcome).toBe('skipped_duplicate');
    expect(sentCount).toBe(1);
  });

  it('two concurrent sends produce exactly one message, not two', async () => {
    // The old shape checked for a duplicate and inserted in the same READ
    // COMMITTED transaction with no unique constraint and no row lock, so two
    // callers — a cron tick and an operator pressing "Send now" — could both
    // pass the check. claim() now takes the appointment row lock and re-checks
    // under it.
    smsHook = async () => {
      await new Promise((r) => setTimeout(r, 40));
    };
    const [a, b] = await Promise.all([
      sendForAppointment(apptId, 'sms'),
      sendForAppointment(apptId, 'sms'),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['sent', 'skipped_duplicate'].sort());
    expect(sentCount).toBe(1);

    const logs = await withoutRls((tx) =>
      tx.messageLog.findMany({ where: { appointmentId: apptId, channel: 'sms' } }),
    );
    expect(logs.length).toBe(1);
  });
});

describe('bounded cron fan-out', () => {
  it('never runs more than `limit` at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);

    const results = await mapWithConcurrency(items, 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });

    expect(peak).toBeLessThanOrEqual(3);
    // Not vacuous: with 25 items and a limit of 3 it must actually reach 3.
    expect(peak).toBe(3);
    expect(results.length).toBe(25);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('CONTROL: an unbounded Promise.all over the same work peaks at 25', async () => {
    // Establishes that `peak` measures something real — the bound is what
    // holds it down, not the workload.
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 25 }, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      }),
    );
    expect(peak).toBe(25);
  });

  it('preserves input order in the results', async () => {
    const results = await mapWithConcurrency([10, 20, 30, 40], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (50 - n) % 17));
      return n;
    });
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([
      10, 20, 30, 40,
    ]);
  });

  it('one failure does not discard the others — the Promise.all trap', async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      if (n === 3) throw new Error('org 3 is broken');
      return n;
    });
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(4);
    const failed = results.filter((r) => r.status === 'rejected');
    expect(failed.length).toBe(1);
    expect(failed[0].status === 'rejected' && failed[0].reason).toContain('org 3 is broken');
  });

  it('concurrency is clamped to the connection pool it has to share', async () => {
    const prevPool = process.env.PG_POOL_MAX;
    const prevConc = process.env.CRON_ORG_CONCURRENCY;
    try {
      process.env.PG_POOL_MAX = '3';
      delete process.env.CRON_ORG_CONCURRENCY;
      expect(cronOrgConcurrency()).toBe(2);

      // A request above the pool size cannot buy parallelism, only queueing.
      process.env.CRON_ORG_CONCURRENCY = '64';
      expect(cronOrgConcurrency()).toBe(3);

      // A larger pool lets the requested value through.
      process.env.PG_POOL_MAX = '10';
      process.env.CRON_ORG_CONCURRENCY = '6';
      expect(cronOrgConcurrency()).toBe(6);

      // Never zero — that would stall the loop forever.
      process.env.CRON_ORG_CONCURRENCY = '0';
      expect(cronOrgConcurrency()).toBeGreaterThanOrEqual(1);
    } finally {
      if (prevPool === undefined) delete process.env.PG_POOL_MAX;
      else process.env.PG_POOL_MAX = prevPool;
      if (prevConc === undefined) delete process.env.CRON_ORG_CONCURRENCY;
      else process.env.CRON_ORG_CONCURRENCY = prevConc;
    }
  });
});
