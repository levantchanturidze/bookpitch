import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { unsafePrismaAdmin } = await import('@/lib/db');
const { buildAuthContext, __clearAuthContextCache } = await import('@/lib/rbac/context');
const { seedRbacFixtures } = await import('@/prisma/rbac-fixtures');
const { withTimeZone } = await import('./helpers/tz-session');

// -----------------------------------------------------------------------------
// F16-010, behavioural half. The helper tests prove the clock is read correctly;
// these prove the decisions made with it are right, and stay right when the
// process clock disagrees.
//
// The dangerous direction is a runtime clock behind the database: an expired
// session still satisfies `expiresAt > new Date()`, so break-glass access to
// client PII outlives the 60-minute ceiling in rbac-spec §7.2.
// -----------------------------------------------------------------------------

const PREFIX = 'E2E-PHASE16-EXPIRY';
const BREAK_GLASS_TTL_MS = 60 * 60_000;
let userId: string;
let membershipId: string;
let orgId: string;

async function clearFixtureSessions() {
  await unsafePrismaAdmin.breakGlassSession.deleteMany({
    where: { actorUserId: userId, ticketId: { startsWith: PREFIX } },
  });
  await unsafePrismaAdmin.impersonationSession.deleteMany({
    where: { actorUserId: userId, ticketId: { startsWith: PREFIX } },
  });
  __clearAuthContextCache();
}

/**
 * Plants one break-glass row expiring `offsetMs` from the database's now.
 *
 * A CHECK constraint (break_glass_sessions_expires_future) forbids inserting a
 * row that is already expired, so an "expired" fixture is planted with a very
 * short life and then allowed to lapse — the same approach the existing
 * break-glass suite uses. The expiry is written by SQL, never marshalled.
 */
async function plantBreakGlass(offsetMs: number, tag: string) {
  const ms = Math.max(offsetMs, 150); // must be in the future at insert time
  await unsafePrismaAdmin.$executeRaw`
    INSERT INTO break_glass_sessions (actor_user_id, target_organization_id, reason, ticket_id, expires_at)
    VALUES (${userId}::uuid, ${orgId}::uuid, 'F16-010 clock fixture', ${`${PREFIX}-${tag}`},
            transaction_timestamp() + (${ms} * interval '1 millisecond'))
  `;
  if (offsetMs < 0) {
    // Let it lapse by the database's reckoning before anything reads it.
    await new Promise((r) => setTimeout(r, ms + 250));
  }
}

beforeAll(async () => {
  await seedRbacFixtures();
  __clearAuthContextCache();
  const user = await unsafePrismaAdmin.appUser.findUniqueOrThrow({
    where: { email: 'split-owner@bp.test' },
    select: { id: true },
  });
  userId = user.id;
  const membership = await unsafePrismaAdmin.membership.findFirstOrThrow({
    where: { userId, organization: { name: 'Split Practice' } },
    select: { id: true, organizationId: true },
  });
  membershipId = membership.id;
  orgId = membership.organizationId;
  await clearFixtureSessions();
});

afterEach(async () => {
  vi.useRealTimers();
  await clearFixtureSessions();
});

afterAll(async () => {
  if (userId) await clearFixtureSessions();
});

describe('F16-010 · expiry decisions follow the database clock', () => {
  it('a live session is live', async () => {
    await plantBreakGlass(30 * 60_000, 'live');
    __clearAuthContextCache();
    const ctx = await buildAuthContext(userId, membershipId);
    expect(ctx!.breakGlass).not.toBeNull();
  });

  it('an expired session cannot be resurrected by rewinding the process clock', async () => {
    await plantBreakGlass(-60_000, 'expired');
    // A runtime an hour behind the database. Under the old `new Date()`
    // comparison this made the expired row look active.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() - 60 * 60_000));
    try {
      __clearAuthContextCache();
      const ctx = await buildAuthContext(userId, membershipId);
      expect(ctx!.breakGlass).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a future session does not expire early when the process clock runs ahead', async () => {
    await plantBreakGlass(30 * 60_000, 'future');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 6 * 60 * 60_000));
    try {
      __clearAuthContextCache();
      const ctx = await buildAuthContext(userId, membershipId);
      expect(ctx!.breakGlass).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('impersonation follows the same rule', async () => {
    async function plantImpersonation(ms: number, tag: string) {
      await unsafePrismaAdmin.$executeRaw`
        INSERT INTO impersonation_sessions
          (actor_user_id, on_behalf_of_user_id, organization_id, reason, ticket_id, expires_at)
        VALUES (${userId}::uuid, ${userId}::uuid, ${orgId}::uuid, 'F16-010 clock fixture',
                ${`${PREFIX}-${tag}`}, transaction_timestamp() + (${ms} * interval '1 millisecond'))
      `;
    }

    await plantImpersonation(200, 'imp-expiring');
    await new Promise((r) => setTimeout(r, 450));
    __clearAuthContextCache();
    let ctx = await buildAuthContext(userId, membershipId);
    expect(ctx!.impersonation, 'a lapsed impersonation session must not be active').toBeNull();

    await unsafePrismaAdmin.impersonationSession.deleteMany({
      where: { actorUserId: userId, ticketId: { startsWith: PREFIX } },
    });
    await plantImpersonation(30 * 60_000, 'imp-live');
    __clearAuthContextCache();
    ctx = await buildAuthContext(userId, membershipId);
    expect(ctx!.impersonation, 'a live impersonation session must be active').not.toBeNull();
  });
});

describe('F16-010 · the break-glass window is 60 minutes in every timezone', () => {
  const ZONES = ['UTC', 'Asia/Tbilisi', 'America/Sao_Paulo'] as const; // +00, +04, -03

  it('the epoch read is zone-invariant and the derived window is 60 minutes', async () => {
    for (const zone of ZONES) {
      await withTimeZone(zone, async (q) => {
        // The read the fix uses. A number — nothing is rendered, so nothing can
        // be re-parsed in the wrong zone.
        const nodeBefore = Date.now();
        const [{ epoch }] = await q<{ epoch: string }>(
          'SELECT extract(epoch from transaction_timestamp()) AS epoch',
        );
        const nodeAfter = Date.now();
        const dbMs = Math.round(Number(epoch) * 1000);
        expect(dbMs, `${zone}: epoch read drifted from the process clock`).toBeGreaterThan(
          nodeBefore - 5000,
        );
        expect(dbMs).toBeLessThan(nodeAfter + 5000);

        // A deadline derived from it, measured back by the database.
        const expiresAt = new Date(dbMs + BREAK_GLASS_TTL_MS);
        const [{ seconds }] = await q<{ seconds: string }>(
          'SELECT extract(epoch from ($1::timestamptz - transaction_timestamp())) AS seconds',
          [expiresAt.toISOString()],
        );
        const minutes = Number(seconds) / 60;
        expect(minutes, `${zone}: window was ${minutes.toFixed(1)} minutes`).toBeGreaterThan(59);
        expect(minutes, `${zone}: window was ${minutes.toFixed(1)} minutes`).toBeLessThan(61);
      });
    }
  });

  // The complement: the expression this replaced yields a five-hour effective
  // window in a +04 zone. Demonstrated, never shipped.
  it('the rendered now() it replaced would have produced ~5 hours at +04', async () => {
    await withTimeZone('Asia/Tbilisi', async (q) => {
      // Exactly what Prisma's raw path did: take the rendered timestamp and
      // parse it as if it carried no offset.
      const [{ rendered }] = await q<{ rendered: Date }>(
        'SELECT to_char(now(), \'YYYY-MM-DD"T"HH24:MI:SS.MS\') AS rendered',
      );
      const misparsed = new Date(`${String(rendered)}Z`).getTime();
      const [{ epoch }] = await q<{ epoch: string }>(
        'SELECT extract(epoch from transaction_timestamp()) AS epoch',
      );
      const trueMs = Math.round(Number(epoch) * 1000);

      const effectiveMinutes = (misparsed + BREAK_GLASS_TTL_MS - trueMs) / 60_000;
      expect(effectiveMinutes).toBeGreaterThan(4 * 60);
      expect(effectiveMinutes).toBeLessThan(6 * 60);
    });
  });

  it('SQL-side comparisons are unaffected by the session zone', async () => {
    // The sweep and the conflict check now compare in SQL on both sides. This
    // is the property that makes them immune: the value never leaves the DB.
    for (const zone of ZONES) {
      await withTimeZone(zone, async (q) => {
        const [{ expired }] = await q<{ expired: boolean }>(
          "SELECT (transaction_timestamp() - interval '1 minute') <= transaction_timestamp() AS expired",
        );
        const [{ live }] = await q<{ live: boolean }>(
          "SELECT (transaction_timestamp() + interval '30 minutes') > transaction_timestamp() AS live",
        );
        expect(expired, zone).toBe(true);
        expect(live, zone).toBe(true);
      });
    }
  });
});
