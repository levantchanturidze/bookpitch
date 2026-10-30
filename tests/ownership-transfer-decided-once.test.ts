import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// The nominee's notification can be made to fail with a real failing
// STATEMENT, which is what aborts a PostgreSQL transaction (a thrown JS error
// would not). Off unless a test arms it.
const { faults } = vi.hoisted(() => ({ faults: { failNomineeNotification: false } }));
vi.mock('@/lib/notifications', async () => {
  const actual = await vi.importActual<typeof import('@/lib/notifications')>('@/lib/notifications');
  return {
    ...actual,
    notifyEvent: async (...args: Parameters<typeof actual.notifyEvent>) => {
      if (faults.failNomineeNotification) {
        await args[0].$executeRawUnsafe('SELECT * FROM injected_missing_table_for_transfer_test');
      }
      return actual.notifyEvent(...args);
    },
  };
});

const { unsafePrismaAdmin } = await import('@/lib/db');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { declineTransfer, nominateTransfer, revokeTransfer } =
  await import('@/lib/admin/ownership-transfer');
const { InvalidInputError } = await import('@/lib/auth');
const { Client } = await import('pg');
const { adminDbUrl } = await import('./helpers/admin-db-url');

import type { ActiveSession } from '@/lib/auth';

// -----------------------------------------------------------------------------
// DEF-43. An ownership transfer is decided once. acceptTransfer claims it with
// a conditional UPDATE (`AND status = 'pending'`), so two accepts cannot both
// win. Decline and revoke checked `pending` on a plain read, then updated by id
// with no status predicate. Racing an accept, either overwrote it: the
// transfer said "revoked" or "declined" after ownership had moved, and decline
// also audited a refusal that never happened.
//
// The accept is simulated on another connection by its own claim statement,
// held uncommitted until the path under test is seen waiting on it.
// -----------------------------------------------------------------------------

let orgId = '';
let fromUserId = '';
let toUserId = '';

const session = (userId: string): ActiveSession => ({
  userId,
  email: 'transfer-race@bp.test',
  organizationId: orgId,
});

async function pendingTransfer(): Promise<string> {
  const row = await unsafePrismaAdmin.ownershipTransfer.create({
    data: {
      organizationId: orgId,
      fromUserId,
      toUserId,
      expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
    },
    select: { id: true },
  });
  return row.id;
}

/** Runs `run` while another connection holds acceptTransfer's claim, uncommitted. */
async function whileAnAcceptIsInFlight<T>(transferId: string, run: () => Promise<T>) {
  const other = new Client({ connectionString: adminDbUrl() });
  await other.connect();
  try {
    await other.query('BEGIN');
    await other.query(
      `UPDATE ownership_transfers SET status = 'accepted', decided_at = now()
        WHERE id = $1::uuid AND status = 'pending'`,
      [transferId],
    );
    const otherPid = (await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      .pid;
    const running = run();
    running.catch(() => undefined); // the caller asserts the outcome
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const rows = await unsafePrismaAdmin.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE ${otherPid} = ANY(pg_blocking_pids(pid))`,
      );
      waiting = Number(rows[0].n) > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    expect(waiting, 'the path under test never waited for the accept').toBe(true);
    await other.query('COMMIT');
    return await running;
  } finally {
    await other.end();
  }
}

const statusOf = async (id: string) =>
  (await unsafePrismaAdmin.ownershipTransfer.findUniqueOrThrow({ where: { id } })).status;
const declineAudits = (id: string) =>
  unsafePrismaAdmin.auditLog.count({
    where: {
      organizationId: orgId,
      action: 'org.ownership.declined',
      meta: { path: ['transferId'], equals: id },
    },
  });

beforeAll(async () => {
  await seedRbacFixtures();
  orgId = (
    await unsafePrismaAdmin.organization.findFirstOrThrow({
      where: { name: 'Split Practice' },
      select: { id: true },
    })
  ).id;
  fromUserId = (
    await unsafePrismaAdmin.appUser.findUniqueOrThrow({ where: { email: 'split-owner@bp.test' } })
  ).id;
  toUserId = (
    await unsafePrismaAdmin.appUser.findUniqueOrThrow({ where: { email: 'moonlight@bp.test' } })
  ).id;
});

beforeEach(async () => {
  faults.failNomineeNotification = false;
  await unsafePrismaAdmin.ownershipTransfer.deleteMany({ where: { organizationId: orgId } });
});

afterAll(async () => {
  await unsafePrismaAdmin.ownershipTransfer.deleteMany({ where: { organizationId: orgId } });
});

describe('DEF-43: an ownership transfer is decided once', () => {
  it('COMPLEMENT: with nothing racing, revoke and decline still work', async () => {
    const revoked = await pendingTransfer();
    await expect(revokeTransfer(session(fromUserId), revoked)).resolves.toEqual({ ok: true });
    expect(await statusOf(revoked)).toBe('revoked');

    await unsafePrismaAdmin.ownershipTransfer.deleteMany({ where: { organizationId: orgId } });
    const declined = await pendingTransfer();
    await expect(declineTransfer(session(toUserId), declined, 'not now')).resolves.toEqual({
      ok: true,
    });
    expect(await statusOf(declined)).toBe('declined');
    expect(await declineAudits(declined)).toBe(1);
  });

  it('a revoke that waited on an accept is refused, and the transfer stays accepted', async () => {
    const id = await pendingTransfer();
    const outcome = whileAnAcceptIsInFlight(id, () => revokeTransfer(session(fromUserId), id));
    await expect(outcome).rejects.toBeInstanceOf(InvalidInputError);
    expect(await statusOf(id)).toBe('accepted');
  });

  it('a decline that waited on an accept is refused, audits nothing, and the transfer stays accepted', async () => {
    const id = await pendingTransfer();
    const outcome = whileAnAcceptIsInFlight(id, () =>
      declineTransfer(session(toUserId), id, 'changed my mind'),
    );
    await expect(outcome).rejects.toBeInstanceOf(InvalidInputError);
    expect(await statusOf(id)).toBe('accepted');
    expect(await declineAudits(id)).toBe(0);
  });
});

describe('DEF-52: a failed nominee notification does not undo the nomination', () => {
  it('the transfer the function reports is the transfer that exists', async () => {
    // The notification is best-effort. It sat in a plain catch inside the
    // nomination's transaction: the failed statement aborted the transaction,
    // the catch swallowed the error, and the COMMIT rolled back the transfer
    // itself, while this function returned its id and emailed the nominee.
    faults.failNomineeNotification = true;
    const result = await nominateTransfer(session(fromUserId), toUserId);
    expect(result.id).toBeTruthy();
    const row = await unsafePrismaAdmin.ownershipTransfer.findUnique({ where: { id: result.id } });
    expect(row?.status, 'the nomination it reported must exist').toBe('pending');
  });

  it('COMPLEMENT: with the notification working, the nomination and its notification both exist', async () => {
    const before = await unsafePrismaAdmin.notification.count({ where: { organizationId: orgId } });
    const result = await nominateTransfer(session(fromUserId), toUserId);
    expect(
      (await unsafePrismaAdmin.ownershipTransfer.findUniqueOrThrow({ where: { id: result.id } }))
        .status,
    ).toBe('pending');
    expect(await unsafePrismaAdmin.notification.count({ where: { organizationId: orgId } })).toBe(
      before + 1,
    );
  });
});
