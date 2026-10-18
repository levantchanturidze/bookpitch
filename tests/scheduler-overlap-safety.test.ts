import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { Client } from 'pg';
import { adminDbUrl } from './helpers/admin-db-url';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// A provider that counts what actually left, and is slow enough that
// overlapping ticks are genuinely in flight at the same time.
const sends: Array<{ channel: 'sms' | 'email'; to: string }> = [];
vi.mock('@/lib/messaging', () => ({
  getSmsProvider: () => ({
    name: 'overlap-sms',
    send: async (to: string) => {
      await new Promise((r) => setTimeout(r, 120));
      sends.push({ channel: 'sms', to });
      return { providerMsgId: `overlap_sms_${sends.length}` };
    },
  }),
  getEmailProvider: () => ({
    name: 'overlap-email',
    send: async (to: string) => {
      await new Promise((r) => setTimeout(r, 120));
      sends.push({ channel: 'email', to });
      return { providerMsgId: `overlap_email_${sends.length}` };
    },
  }),
}));

const { withoutRls, unsafePrismaAdmin } = await import('@/lib/db');
const { runReminderTick } = await import('@/lib/messaging/reminders');
const { runHousekeeping, HOUSEKEEPING_LOCK_KEY } = await import('@/lib/housekeeping');

// -----------------------------------------------------------------------------
// Backlog G adds schedule lines, so deliveries of the reminder tick and of
// housekeeping overlap more often than before (2026-10-18). The safety argument
// for that is two mechanisms. These tests prove each at the function the cron
// routes call, instead of assuming them:
//
// - reminders: claim() locks the appointment row and re-checks for a
//   duplicate under the lock, so overlapping ticks send each reminder once;
// - housekeeping: pg_try_advisory_xact_lock makes an overlapping run a no-op.
// -----------------------------------------------------------------------------

const FIXTURE_ORG = 'Scheduler overlap fixture';
let orgId: string;
let apptId: string;

beforeAll(async () => {
  const fx = await withoutRls(async (tx) => {
    // Reused by name: reminder settlement writes audit rows, and audit_log
    // (append-only) holds a foreign key to the organisation. Archived, because
    // a live ownerless organisation breaks the ownership invariant.
    const org =
      (await tx.organization.findFirst({ where: { name: FIXTURE_ORG }, select: { id: true } })) ??
      (await tx.organization.create({
        data: { name: FIXTURE_ORG, vertical: 'clinic', reminderLeadHours: 24, status: 'archived' },
        select: { id: true },
      }));
    await tx.messageLog.deleteMany({ where: { organizationId: org.id } });
    await tx.appointment.deleteMany({ where: { organizationId: org.id } });
    const loc =
      (await tx.location.findFirst({ where: { organizationId: org.id }, select: { id: true } })) ??
      (await tx.location.create({
        data: { organizationId: org.id, name: 'Overlap', type: 'clinic', timezone: 'UTC' },
        select: { id: true },
      }));
    const staff =
      (await tx.staff.findFirst({ where: { organizationId: org.id }, select: { id: true } })) ??
      (await tx.staff.create({
        data: { organizationId: org.id, locationId: loc.id, name: 'Overlap Dr', roleTitle: 'GP' },
        select: { id: true },
      }));
    const customer =
      (await tx.customer.findFirst({ where: { organizationId: org.id }, select: { id: true } })) ??
      (await tx.customer.create({
        data: {
          organizationId: org.id,
          name: 'Overlap Customer',
          email: 'overlap@bp.test',
          phone: '+995500000118',
        },
        select: { id: true },
      }));
    // Inside the 24-hour window: every tick that runs now owes this reminder.
    const startsAt = new Date(Date.now() + 2 * 3_600_000);
    const appt = await tx.appointment.create({
      data: {
        organizationId: org.id,
        locationId: loc.id,
        customerId: customer.id,
        staffId: staff.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        serviceName: 'Overlap check',
        price: 10,
        status: 'confirmed',
      },
      select: { id: true },
    });
    return { orgId: org.id, apptId: appt.id };
  });
  orgId = fx.orgId;
  apptId = fx.apptId;
});

beforeEach(async () => {
  sends.length = 0;
  await withoutRls((tx) => tx.messageLog.deleteMany({ where: { organizationId: orgId } }));
});

afterAll(async () => {
  await withoutRls(async (tx) => {
    await tx.messageLog.deleteMany({ where: { organizationId: orgId } });
    await tx.appointment.deleteMany({ where: { organizationId: orgId } });
    await tx.rateLimit.deleteMany({ where: { organizationId: orgId } });
  });
});

async function logs() {
  const rows = await unsafePrismaAdmin.messageLog.findMany({
    where: { appointmentId: apptId },
    select: { channel: true, state: true },
  });
  // `channel` is an enum, so ORDER BY follows its declaration, not the alphabet.
  return rows.sort((a, b) => a.channel.localeCompare(b.channel));
}

describe('overlapping reminder ticks send each reminder exactly once', () => {
  it('two ticks in flight at once: one SMS and one email, not two of each', async () => {
    await Promise.all([runReminderTick(orgId), runReminderTick(orgId)]);
    expect(sends.map((s) => s.channel).sort()).toEqual(['email', 'sms']);
    expect(await logs()).toEqual([
      { channel: 'email', state: 'sent' },
      { channel: 'sms', state: 'sent' },
    ]);
  });

  it('a burst of three ticks still sends once per channel', async () => {
    await Promise.all([runReminderTick(orgId), runReminderTick(orgId), runReminderTick(orgId)]);
    expect(sends).toHaveLength(2);
    expect((await logs()).filter((l) => l.state === 'sent')).toHaveLength(2);
  });

  it('a tick after the reminder was sent sends nothing more', async () => {
    await runReminderTick(orgId);
    sends.length = 0;
    await runReminderTick(orgId);
    expect(sends).toEqual([]);
    expect(await logs()).toHaveLength(2);
  });
});

describe('an overlapping housekeeping run is a no-op', () => {
  it('while another session holds the lock, a run sweeps nothing; afterwards, it sweeps', async () => {
    const bucket = `overlap-stale-${Date.now()}`;
    await unsafePrismaAdmin.$executeRaw`
      INSERT INTO rate_limit (organization_id, bucket, window_start, count)
      VALUES (${orgId}::uuid, ${bucket}, timestamptz '2020-01-01 00:00Z', 1)`;
    const stillThere = async () =>
      (await unsafePrismaAdmin.rateLimit.count({ where: { organizationId: orgId, bucket } })) > 0;

    // The other run: holds the transaction-scoped lock and has not finished.
    const other = new Client({ connectionString: adminDbUrl() });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT pg_advisory_xact_lock($1::bigint)', [
        HOUSEKEEPING_LOCK_KEY.toString(),
      ]);
      const overlapping = await runHousekeeping();
      expect(overlapping.rateLimit, 'the overlapping run must sweep nothing').toBe(0);
      expect(overlapping.outboxSent).toBe(0);
      expect(await stillThere()).toBe(true);
    } finally {
      await other.query('ROLLBACK');
      await other.end();
    }

    // COMPLEMENT: the same row, once nobody holds the lock, is swept.
    const alone = await runHousekeeping();
    expect(alone.rateLimit).toBeGreaterThanOrEqual(1);
    expect(await stillThere()).toBe(false);
  });
});
